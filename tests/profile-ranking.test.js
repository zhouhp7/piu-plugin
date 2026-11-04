import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RankingStore} from '../src/ranking-store.js';
import {lookupWorldRank, enrichProfileRanking} from '../src/profile-ranking.js';
import {createService} from '../src/service.js';

function fixture(t) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'piu-profile-rank-'));
  const filename = path.join(dataDir, 'rankings.sqlite');
  const store = new RankingStore({filename});
  t.after(() => {store.close(); rmSync(dataDir, {recursive: true, force: true});});
  const save = (capturedAt, playerName = 'ZANTING') => store.saveSnapshot({
    date: '20261103', capturedAt, kind: 'manual',
    entries: Array.from({length: 1000}, (_, i) => ({
      playerKey: `game:${i === 994 ? playerName : `PLAYER${i + 1}`}#9403`,
      gameId: i === 994 ? playerName : `PLAYER${i + 1}`, tag: '#9403',
      worldRank: i + 1, score: 20000 - i, country: null, lastPlayedAt: null,
    })),
  });
  return {dataDir, filename, store, save};
}

test('B50 rank uses exact complete identity and preserves its source profile', t => {
  const f = fixture(t);
  f.save('2026-11-02T17:00:00Z');
  assert.deepEqual(lookupWorldRank(f.filename, 'ZANTING#9403'), {worldRank: 995, capturedAt: '2026-11-02T17:00:00.000Z'});
  assert.equal(lookupWorldRank(f.filename, 'PLAYER1#9403').worldRank, 1);
  assert.equal(lookupWorldRank(f.filename, 'zanting#9403').worldRank,995);
  for (const identity of ['#9403', 'ZANTING', 'MISSING#9403']) {
    assert.equal(lookupWorldRank(f.filename, identity), null);
  }
  const profile = {playerName: 'ZANTING#9403', pumbility: 17841.83, ranking: null, records: []};
  assert.equal(enrichProfileRanking(profile, {dataDir: f.dataDir}).ranking, '995');
  assert.equal(profile.ranking, null);
});

test('a player absent from newest complete snapshot never inherits an earlier rank', t => {
  const f = fixture(t);
  f.save('2026-11-02T17:00:00Z');
  f.save('2026-11-02T18:00:00Z', 'REPLACEMENT');
  assert.equal(lookupWorldRank(f.filename, 'ZANTING#9403'), null);
  assert.equal(lookupWorldRank(f.filename, 'REPLACEMENT#9403').worldRank, 995);
});

test('missing or unreadable optional rank database does not create files or block B50', t => {
  const f = fixture(t);
  const profile = {playerName: 'ZANTING#9403', ranking: null};
  const missing = path.join(f.dataDir, 'missing.sqlite');
  assert.strictEqual(enrichProfileRanking(profile, {filename: missing}), profile);
  assert.equal(existsSync(missing), false);
  const corrupt = path.join(f.dataDir, 'corrupt.sqlite');
  writeFileSync(corrupt, 'not a SQLite database');
  const errors = [];
  assert.strictEqual(enrichProfileRanking(profile, {filename: corrupt, onError: error => errors.push(error)}), profile);
  assert.equal(errors.length, 1);
});

test('authenticated B50 and CLI fetch path pass persisted world rank to the renderer', async t => {
  const f = fixture(t);
  f.save('2026-11-02T17:00:00Z');
  const profile = {playerName: 'ZANTING#9403', pumbility: 17841.83, ranking: null, records: []};
  let rendered;
  const service = await createService({dataDir: f.dataDir, cacheMs: 120000, maxFetches: 2, sessionMaxAgeMs: 86400000}, {
    vault: {async load() {return {version:2,accounts:[{id:'account',state:{},savedAt:Date.now(),gameIds:[{id:'profile',playerName:'ZANTING#9403'}]}]};}, async save() {}},
    browser: {async close() {}},
    createBridge: async () => ({async close() {}}),
    fetchProfile: async () => ({profile, state: {}, images: new Map()}),
    renderBest50: async value => {rendered = value; return Buffer.from('rendered');},
  });
  try {
    assert.equal((await service.best50('owner', 'ZANTING#9403')).toString(), 'rendered');
    assert.equal(rendered.playerName, 'ZANTING#9403');
    assert.equal(rendered.ranking, '995');
    assert.equal(profile.ranking, null);
  } finally {await service.close();}
});
