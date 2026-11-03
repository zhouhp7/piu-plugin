import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createCanvas} from '@napi-rs/canvas';
import {extractJacketUrls, parseJacketCataloguePage, prefetchJackets, JACKET_CATALOGUE_URL} from '../src/jacket-prefetch.js';

const art = hash => `https://piugame.com/data/song_img2/${hash}.png?v=1`;
const html = (hash, next = '') => `<ul><li style="display:none"><div class="songImg_w"><div class="re" style="background-image:url('${art(hash)}')"></div></div></li></ul>
 <img src="${art(hash).replace('v=1','v=2')}"><img src="https://piugame.com/data/avatar_img2/avatar.png">
 <div class="board_paging">${next ? `<button onclick="location.href='?&&page=${next}'">${next}</button>` : ''}<button onclick="location.href='?&&page=128'">last</button></div>`;

test('catalogue parser includes hidden song art, deduplicates version queries and excludes avatars', () => {
  assert.deepEqual(extractJacketUrls(html('first', '2')), ['https://www.piugame.com/data/song_img2/first.png?v=1']);
  assert.equal(parseJacketCataloguePage(html('first', '2')).nextPage, 2);
  assert.equal(parseJacketCataloguePage(html('second'), {page: 2}).nextPage, null);
  assert.throws(() => parseJacketCataloguePage('<form id="login_fs"><input name="mb_password"></form>'), {code: 'RANK_AUTH'});
});

test('bounded catalogue prefetch saves originals and subsequent calls use only local art', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'piu-jacket-prefetch-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const png = await createCanvas(4, 4).encode('png');
  let url = '', downloads = 0, closed = 0;
  const visited = [];
  const routes = [];
  const page = {
    url: () => url,
    async goto(value) {url = value; visited.push(value); return {ok: () => true};},
    async content() {return Number(new URL(url).searchParams.get('page')) === 1 ? html('one', '2') : html('two');},
    evaluate: (fn, source) => vm.runInNewContext(`(${fn.toString()})(source)`, {
      source, location: {origin: 'https://www.piugame.com'}, URL, AbortSignal,
      btoa: value => Buffer.from(value, 'binary').toString('base64'),
      fetch: async value => {assert.match(value, /^https:\/\/www\.piugame\.com\/data\/song_img2\//); downloads++; return new Response(png, {headers: {'content-type':'image/png'}});},
    }),
  };
  const manager = {config: {}, async context() {return {route: async (_pattern, handler) => {routes.push(handler);}, newPage: async () => page, close: async () => {closed++;}};}};
  const first = await prefetchJackets(manager, {}, {cacheDirectory: directory, maxPages: 2});
  assert.equal(first.pages, 2); assert.equal(first.discovered, 2); assert.equal(first.downloaded, 2);
  assert.equal(first.failed, 0); assert.equal(first.stats.count, 2); assert.equal(downloads, 2);
  const second = await prefetchJackets(manager, {}, {cacheDirectory: directory, maxPages: 2});
  assert.equal(second.cached, 2); assert.equal(second.downloaded, 0); assert.equal(downloads, 2);
  const limited = await prefetchJackets(manager, {}, {cacheDirectory: directory, maxPages: 2, maxImages: 1});
  assert.equal(limited.pages, 1); assert.equal(limited.discovered, 1); assert.equal(limited.cached, 1);
  const onePage = await prefetchJackets(manager, {}, {cacheDirectory: directory, maxPages: 1});
  assert.equal(onePage.pages, 1); assert.equal(onePage.discovered, 1);
  assert.equal(closed, 4);
  assert.ok(visited.every(value => value.startsWith(JACKET_CATALOGUE_URL)));
  for (const type of ['image', 'font', 'stylesheet', 'media', 'fetch', 'script']) {
    const outcome = routes[0]({request: () => ({resourceType: () => type}), abort: () => 'blocked', fallback: () => 'allowlist'});
    assert.equal(outcome, ['fetch', 'script'].includes(type) ? 'allowlist' : 'blocked');
  }
});

test('a transient missing jacket gets one bounded retry and then persists locally', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'piu-jacket-retry-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const png = await createCanvas(4, 4).encode('png');
  let downloads = 0;
  const page = {
    url: () => JACKET_CATALOGUE_URL,
    goto: async () => ({ok: () => true}),
    content: async () => html('retry'),
    evaluate: (fn, source) => vm.runInNewContext(`(${fn.toString()})(source)`, {
      source, location: {origin: 'https://www.piugame.com'}, URL, AbortSignal,
      btoa: value => Buffer.from(value, 'binary').toString('base64'),
      fetch: async () => {if (++downloads === 1) throw new Error('temporary timeout'); return new Response(png, {headers: {'content-type': 'image/png'}});},
    }),
  };
  const manager = {config: {}, async context() {return {newPage: async () => page, close: async () => {}};}};
  const first = await prefetchJackets(manager, {}, {cacheDirectory: directory, maxPages: 1});
  assert.equal(first.downloaded, 1); assert.equal(first.failed, 0); assert.equal(downloads, 2);
  assert.equal((await prefetchJackets(manager, {}, {cacheDirectory: directory, maxPages: 1})).cached, 1);
  assert.equal(downloads, 2);
});

test('prefetch obeys image and page limits and closes a redirected login context', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'piu-jacket-limit-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  let closed = false;
  const manager = {config: {}, async context() {return {newPage: async () => ({
    goto: async () => ({ok: () => true}), url: () => 'https://www.piugame.com/login.php',
  }), close: async () => {closed = true;}};}};
  await assert.rejects(prefetchJackets(manager, {}, {cacheDirectory:directory}), {code:'RANK_AUTH'});
  assert.equal(closed, true);
  await assert.rejects(prefetchJackets(manager, {}, {maxPages:0}), TypeError);
  await assert.rejects(prefetchJackets(manager, {}, {maxImages:1001}), TypeError);
});
