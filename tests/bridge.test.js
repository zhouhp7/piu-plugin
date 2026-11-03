import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/bridge.js';

async function fixture(t, overrides = {}) {
  let closes = 0, saves = 0;
  const page = {
    url: () => 'https://api.am-pass.net/sso?sid=secret#hidden',
    screenshot: async () => Buffer.from('screenshot'), viewportSize: () => ({ width: 390, height: 844 }),
    mouse: { click: async () => {}, wheel: async () => {} }, keyboard: { press: async () => {}, insertText: async () => {} },
    evaluate: async () => true
  };
  const bridge = await createBridge({ host: '127.0.0.1', port: 0, publicUrl: 'http://localhost', ttlMs: 30000,
    createLogin: async () => ({ page, context: { storageState: async () => ({ cookies: [] }), close: async () => { closes++; } } }),
    validateLogin: async () => ({ name: 'PIU' }), saveSession: async () => { saves++; }, ...overrides });
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.address.port}`;
  const request = async (route, data, auth = {}, origin = 'http://localhost') => {
    const response = await fetch(`${url}/api/${route}`, { method: data === undefined ? 'GET' : 'POST', headers: {
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(origin ? { Origin: origin } : {}),
      ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.csrf ? { 'X-CSRF-Token': auth.csrf } : {})
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { response, data: await response.json() };
  };
  const claim = async ticket => {
    const result = await request('claim', { token: new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('token') });
    return { ...result, cookie: result.response.headers.get('set-cookie')?.split(';')[0], csrf: result.data.csrf };
  };
  return { bridge, page, url, request, claim, closes: () => closes, saves: () => saves };
}

test('ticket is single use; cookie and CSRF protect remote state and actions', async t => {
  const f = await fixture(t);
  const ticket = await f.bridge.createTicket('qq:123');
  assert.equal(new URL(ticket.url).search, '');
  const auth = await f.claim(ticket);
  assert.equal(auth.response.status, 200);
  assert.match(auth.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await f.claim(ticket)).response.status, 410);
  assert.equal((await f.request('state', undefined)).response.status, 401);
  assert.equal((await f.request('state', undefined, { cookie: auth.cookie })).response.status, 403);
  assert.equal((await f.request('action', { type: 'key', key: 'Enter' }, auth, 'https://evil.example')).response.status, 403);
  const state = await f.request('state', undefined, auth);
  assert.equal(state.data.url, 'https://api.am-pass.net/sso');
  assert.equal(state.data.image, Buffer.from('screenshot').toString('base64'));
  assert.equal((await f.request('action', { type: 'key', key: 'Control+L' }, auth)).response.status, 400);
  assert.equal((await f.request('action', { type: 'click', x: 390, y: 4 }, auth)).response.status, 400);
  await f.bridge.revoke('qq:123');
  assert.equal(f.closes(), 1);
  assert.equal((await f.request('state', undefined, auth)).response.status, 401);
});

test('claim requires same origin and consent to finish saves only after official validation', async t => {
  let valid = false;
  const f = await fixture(t, { validateLogin: async () => valid ? { name: 'PIU' } : null });
  const ticket = await f.bridge.createTicket('user');
  const token = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('token');
  assert.equal((await f.request('claim', { token }, {}, null)).response.status, 403);
  const auth = await f.claim(ticket);
  assert.equal((await f.request('finish', {}, auth)).response.status, 409);
  assert.equal(f.saves(), 0);
  valid = true;
  assert.equal((await f.request('finish', {}, auth)).response.status, 200);
  assert.equal(f.saves(), 1);
  assert.equal(f.closes(), 1);
  assert.equal((await f.request('state', undefined, auth)).response.status, 401);
});

test('capacity, replacement, and expiry release browser resources', async t => {
  const f = await fixture(t, { maxSessions: 1, ttlMs: 1000 });
  const ticket = await f.bridge.createTicket('one');
  await assert.rejects(f.bridge.createTicket('two'), /繁忙/);
  const auth = await f.claim(ticket);
  const replacement = await f.bridge.createTicket('one');
  assert.equal(f.closes(), 1);
  assert.equal((await f.request('state', undefined, auth)).response.status, 401);
  const second = await f.claim(replacement);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await f.request('state', undefined, second)).response.status, 401);
  assert.equal(f.closes(), 2);
  assert.ok((await f.bridge.createTicket('two')).url);
});

test('revoke waits for in-flight save before caller deletes persisted session', async t => {
  let begin, complete;
  const started = new Promise(resolve => { begin = resolve; });
  const release = new Promise(resolve => { complete = resolve; });
  let saved = false;
  const f = await fixture(t, { saveSession: async () => { begin(); await release; saved = true; } });
  const auth = await f.claim(await f.bridge.createTicket('one'));
  const finishing = f.request('finish', {}, auth);
  await started;
  let revoked = false;
  const revoke = f.bridge.revoke('one').then(() => { revoked = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(revoked, false);
  complete();
  await revoke;
  assert.equal(saved, true);
  await finishing;
  assert.equal(f.closes(), 1);
});

test('public login requires HTTPS and HTML uses a nonce CSP without exposing ticket', async t => {
  await assert.rejects(createBridge({ publicUrl: 'http://example.com' }), /HTTPS/);
  const f = await fixture(t);
  const response = await fetch(`${f.url}/login`);
  const html = await response.text();
  assert.match(response.headers.get('content-security-policy'), /script-src 'nonce-/);
  assert.ok(!html.includes('{{NONCE}}'));
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(html, /不是 PIU 官方扫码登录/);
});


test('revoke closes a browser whose startup was already in progress', async t => {
  let started, release;
  const beginning = new Promise(resolve => { started = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  let closes = 0;
  const f = await fixture(t, { createLogin: async () => {
    started(); await resume;
    return { page: {}, context: { close: async () => { closes++; } } };
  } });
  const ticket = await f.bridge.createTicket('user');
  const claiming = f.claim(ticket);
  await beginning;
  const revoking = f.bridge.revoke('user');
  release();
  await revoking;
  assert.equal(closes, 1);
  assert.equal((await claiming).response.status, 410);
});

test('typing requires a focused editable element and screenshot work is bounded', async t => {
  const f = await fixture(t);
  const auth = await f.claim(await f.bridge.createTicket('user'));
  f.page.evaluate = async () => false;
  assert.equal((await f.request('action', {type: 'type', text: 'private'}, auth)).response.status, 409);
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.page.screenshot = async () => { began(); await blocked; return Buffer.from('image'); };
  const first = f.request('state', undefined, auth);
  await started;
  const second = f.request('state', undefined, auth);
  const third = f.request('state', undefined, auth);
  await new Promise(resolve => setTimeout(resolve, 20));
  const fourth = await f.request('state', undefined, auth);
  assert.equal(fourth.response.status, 429);
  release();
  await Promise.all([first, second, third]);
});
