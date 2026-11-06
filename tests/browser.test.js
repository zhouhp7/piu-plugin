import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chromium} from 'playwright';
import {BrowserManager} from '../src/browser.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function fakeBrowser({closeWait, emitOnClose = true} = {}) {
  const browser = new EventEmitter();
  let connected = true;
  browser.closes = 0;
  browser.isConnected = () => connected;
  browser.disconnect = () => { connected = false; browser.emit('disconnected'); };
  browser.newContext = async () => {
    if (!connected) throw new Error('Browser has been closed');
    return {setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async route() {}, async routeWebSocket() {}, on() {}};
  };
  browser.close = async () => {
    browser.closes++;
    if (closeWait) await closeWait;
    connected = false;
    if (emitOnClose) browser.emit('disconnected');
  };
  return browser;
}

test('concurrent callers share one launch and recover after a browser disconnects', async t => {
  const launchWait = deferred();
  const first = fakeBrowser(), second = fakeBrowser();
  let launches = 0;
  t.mock.method(chromium, 'launch', async () => {
    launches++;
    return launches === 1 ? launchWait.promise : second;
  });
  const manager = new BrowserManager();
  const initial = [manager.context(), manager.context()];
  assert.equal(launches, 1);
  launchWait.resolve(first);
  await Promise.all(initial);
  first.disconnect();
  await Promise.all([manager.context(), manager.context()]);
  assert.equal(launches, 2);
  assert.equal(await manager.browser(), second);
  await manager.close();
});

test('failed launches and browsers disconnected during startup remain retryable', async t => {
  const disconnected = fakeBrowser();
  disconnected.disconnect();
  const healthy = fakeBrowser();
  let launches = 0;
  t.mock.method(chromium, 'launch', async () => {
    launches++;
    if (launches === 1) throw new Error('launch failed');
    return launches === 2 ? disconnected : healthy;
  });
  const manager = new BrowserManager();
  await assert.rejects(manager.context(), /launch failed/);
  await assert.rejects(manager.context(), /disconnected during startup/);
  await manager.context();
  assert.equal(launches, 3);
  await manager.close();
});

test('close waits for startup and concurrent callers wait for shutdown before relaunching', async t => {
  const launchWait = deferred(), closeWait = deferred();
  const first = fakeBrowser({closeWait: closeWait.promise, emitOnClose: false}), second = fakeBrowser();
  let launches = 0;
  t.mock.method(chromium, 'launch', async () => ++launches === 1 ? launchWait.promise : second);
  const manager = new BrowserManager();
  const opening = manager.browser();
  const closing = manager.close(), joiningClose = manager.close();
  const next = manager.browser();
  assert.equal(launches, 1);
  launchWait.resolve(first);
  assert.equal(await opening, first);
  await Promise.resolve();
  assert.equal(first.closes, 1);
  assert.equal(launches, 1);
  closeWait.resolve();
  await Promise.all([closing, joiningClose]);
  assert.equal(await next, second);
  assert.equal(launches, 2);
  // A late event from the old process must not discard the replacement browser.
  first.emit('disconnected');
  assert.equal(await manager.browser(), second);
  assert.equal(launches, 2);
  await manager.close();
});

test('close absorbs a pending launch failure and permits a later launch', async t => {
  const launchWait = deferred();
  const healthy = fakeBrowser();
  let launches = 0;
  t.mock.method(chromium, 'launch', async () => ++launches === 1 ? launchWait.promise : healthy);
  const manager = new BrowserManager();
  const opening = assert.rejects(manager.browser(), /launch failed/);
  const closing = manager.close();
  launchWait.reject(new Error('launch failed'));
  await Promise.all([opening, closing]);
  assert.equal(await manager.browser(), healthy);
  assert.equal(launches, 2);
  await manager.close();
});
