import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCanvas} from '@napi-rs/canvas';
import {JacketCache, canonicalJacketUrl} from '../src/jacket-cache.js';

const source = 'https://www.piugame.com/data/song_img2/abc123.png?v=one';
const png = await createCanvas(4, 4).encode('png');
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'piu-jacket-cache-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return new JacketCache({directory});
}

test('only immutable official song paths are cache identities, with version queries removed', () => {
  assert.equal(canonicalJacketUrl(source), 'https://www.piugame.com/data/song_img2/abc123.png');
  assert.equal(canonicalJacketUrl(source.replace('www.', '')), canonicalJacketUrl(source));
  assert.equal(canonicalJacketUrl(source, {keepQuery: true}), source);
  for (const value of [
    'http://www.piugame.com/data/song_img2/a.png',
    'https://evil.test/data/song_img2/a.png',
    'https://www.piugame.com.evil.test/data/song_img2/a.png',
    'https://u:p@www.piugame.com/data/song_img2/a.png',
    'https://www.piugame.com:8443/data/song_img2/a.png',
    'https://www.piugame.com/data/avatar_img2/a.png',
    'https://www.piugame.com/data/song_img2/../avatar_img2/a.png',
    'https://www.piugame.com/data/song_img2/%2e%2e%2fa.png',
  ]) assert.equal(canonicalJacketUrl(value), null, value);
});

test('original bytes persist and are reused across users, instances and query versions', async t => {
  const cache = await fixture(t);
  let loads = 0;
  const loader = async () => {loads++; return png;};
  assert.deepEqual(await cache.getOrLoad(source, loader), png);
  const other = new JacketCache({directory: cache.directory});
  assert.deepEqual(await other.getOrLoad(source.replace('v=one', 'v=two'), loader), png);
  assert.equal(loads, 1);
  assert.equal(cache.fileFor(source), other.fileFor(source.replace('v=one', 'v=two')));
  assert.deepEqual(await readFile(cache.fileFor(source)), png);
  const stats = await cache.stats();
  assert.equal(stats.count, 1); assert.equal(stats.bytes, png.length);
});

test('concurrent missing-art requests share one download even through different cache instances', async t => {
  const cache = await fixture(t);
  const other = new JacketCache({directory: cache.directory});
  let begin, release, loads = 0;
  const started = new Promise(resolve => {begin = resolve;});
  const waiting = new Promise(resolve => {release = resolve;});
  const loader = async () => {loads++; begin(); await waiting; return png;};
  const first = cache.getOrLoad(source, loader); await started;
  const rest = [cache.getOrLoad(source, loader), other.getOrLoad(source.replace('v=one','v=other'), loader)];
  release();
  for (const bytes of await Promise.all([first, ...rest])) assert.deepEqual(bytes, png);
  assert.equal(loads, 1);
});

test('truncated files with valid PNG magic are repaired and failed downloads leave no bad cache', async t => {
  const cache = await fixture(t);
  await writeFile(cache.fileFor(source), png.subarray(0, 32));
  assert.equal(await cache.get(source), null);
  assert.deepEqual(await cache.getOrLoad(source, async () => png), png);
  const bad = source.replace('abc123', 'bad');
  assert.equal(await cache.getOrLoad(bad, async () => png.subarray(0, 32)), null);
  assert.equal(await cache.get(bad), null);
  await assert.rejects(cache.getOrLoad(bad, async () => {throw new Error('temporary');}), /temporary/);
  assert.deepEqual(await cache.getOrLoad(bad, async () => png), png);
  assert.equal((await cache.stats()).count, 2);
});

test('oversized or foreign art never enters the cache or invokes a foreign loader', async t => {
  const cache = await fixture(t);
  let called = false;
  assert.equal(await cache.getOrLoad('https://evil.test/a.png', async () => {called = true; return png;}), null);
  assert.equal(called, false);
  const huge = Buffer.alloc(4_000_001); png.copy(huge);
  assert.equal(await cache.getOrLoad(source, async () => huge), null);
  assert.equal((await cache.stats()).count, 0);
});
