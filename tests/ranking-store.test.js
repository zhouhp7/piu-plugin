import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RankingStore} from '../src/ranking-store.js';
import {zoned01} from '../src/ranking-time.js';

const entries = () => [
  {playerKey: 'name:SHAWN#1477', gameId: 'SHAWN', tag: '#1477', worldRank: 1, score: 19014.20, country: 'CN', lastPlayedAt: '2026-11-01 13:05:44'},
  {playerKey: 'name:YINBEST#3231', gameId: 'YINBEST', tag: '#3231', worldRank: 2, score: 18929.80, country: 'CN', lastPlayedAt: '2026-11-01 16:34:09'},
  {playerKey: 'source:12345', gameId: 'CHIPHANT', tag: '#5633', worldRank: 3, score: 18556.28, country: 'CN', lastPlayedAt: null, sourceId: '12345'},
];
const snapshot = (override = {}) => ({
  date: '20261103', scheduledAt: zoned01('20261103'), capturedAt: '2026-11-02T17:00:12.000Z',
  sourceUpdatedAt: '2026-11-03 01:00:00', kind: 'scheduled', entries: entries(), audit: {pages: 20}, ...override,
});
function memory(t) {
  const store = new RankingStore({filename: ':memory:', minEntries: 3});
  t.after(() => store.close());
  return store;
}

test('complete snapshots persist to real SQLite and retain source metadata', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'piu-ranking-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const filename = path.join(directory, 'nested', 'ranking.sqlite');
  let store = new RankingStore({filename, minEntries: 3});
  const saved = store.saveSnapshot(snapshot());
  assert.equal(saved.count, 3);
  assert.deepEqual(saved.audit, {pages: 20});
  store.close();
  store = new RankingStore({filename, minEntries: 3});
  t.after(() => store.close());
  assert.deepEqual(store.getSnapshot('20261103'), {...saved, entries: entries()});
  assert.deepEqual(store.latestSnapshot(), store.getSnapshot('20261103'));
  assert.equal(store.getSnapshot('20261102'), null);
});

test('official store requires all 1000 distinct rows and permits repeated four-digit tags', t => {
  const store = new RankingStore({filename: ':memory:'});
  t.after(() => store.close());
  assert.throws(() => store.saveSnapshot(snapshot()), {code: 'RANK_SNAPSHOT'});
  const thousand = Array.from({length: 1000}, (_, index) => ({
    playerKey: `source:${index}`, sourceId: String(index), gameId: `PLAYER${index}`, tag: '#1477',
    worldRank: index + 1, score: 20000 - index, country: null, lastPlayedAt: null,
  }));
  assert.equal(store.saveSnapshot(snapshot({entries: thousand})).count, 1000);
  assert.equal(store.getSnapshot('20261103').entries.filter(row => row.tag === '#1477').length, 1000);
});

test('ties and competition-rank gaps are legal while malformed ranking order is rejected', t => {
  const store = memory(t);
  const tied = entries();
  tied[1].worldRank = 1;
  tied[2].worldRank = 3;
  store.saveSnapshot(snapshot({entries: tied}));
  assert.deepEqual(store.getSnapshot('20261103').entries.map(row => row.worldRank), [1, 1, 3]);
  const reversed = entries();
  reversed[2].worldRank = 1;
  assert.throws(() => store.saveSnapshot(snapshot({capturedAt: '2026-11-02T17:00:13Z', entries: reversed})), {code: 'RANK_SNAPSHOT'});
  assert.equal(store.listSnapshots().length, 1);
});

test('invalid and partial batches never create or modify any saved snapshot', t => {
  const store = memory(t);
  store.saveSnapshot(snapshot());
  const duplicate = entries();
  duplicate[2].playerKey = duplicate[0].playerKey;
  const invalidScore = entries();
  invalidScore[2].score = Number.NaN;
  const invalidTag = entries();
  invalidTag[1].tag = '#12';
  for (const rows of [entries().slice(0, 2), duplicate, invalidScore, invalidTag]) {
    assert.throws(() => store.saveSnapshot(snapshot({capturedAt: '2026-11-02T17:00:13Z', entries: rows})), {code: 'RANK_SNAPSHOT'});
  }
  assert.equal(store.listSnapshots().length, 1);
  assert.deepEqual(store.getSnapshot('20261103').entries, entries());
});

test('manual captures never replace the 01:00 slot and every capture retains its actual time', t => {
  const store = memory(t);
  store.saveSnapshot(snapshot({kind: 'manual', scheduledAt: null, capturedAt: '2026-11-03T06:00:00Z'}));
  assert.equal(store.getSnapshot('20261103').kind, 'manual');
  assert.equal(store.getSnapshot('20261103').capturedAt, '2026-11-03T06:00:00.000Z');
  store.saveSnapshot(snapshot({kind: 'catchup', capturedAt: '2026-11-02T17:05:00Z'}));
  store.saveSnapshot(snapshot());
  store.saveSnapshot(snapshot({kind: 'manual', scheduledAt: null, capturedAt: '2026-11-03T07:00:00Z'}));
  assert.equal(store.getSnapshot('20261103').kind, 'scheduled');
  assert.equal(store.getSnapshot('20261103').capturedAt, '2026-11-02T17:00:12.000Z');
  assert.equal(store.listSnapshots().length, 4);
});

test('a same-date manual fallback chooses the latest actual capture and never another date', t => {
  const store = memory(t);
  for (const capturedAt of ['2026-11-03T06:00:00Z', '2026-11-03T07:00:00Z']) {
    store.saveSnapshot(snapshot({kind: 'manual', scheduledAt: null, capturedAt}));
  }
  assert.equal(store.getSnapshot('20261103').capturedAt, '2026-11-03T07:00:00.000Z');
  assert.equal(store.getSnapshot('20261102'), null);
});

test('history is immutable and identical retries are idempotent', t => {
  const store = memory(t);
  const first = store.saveSnapshot(snapshot());
  assert.deepEqual(store.saveSnapshot(snapshot()), first);
  const changed = entries();
  changed[0].score += 10;
  assert.throws(() => store.saveSnapshot(snapshot({entries: changed})), {code: 'RANK_SNAPSHOT'});
  assert.equal(store.listSnapshots().length, 1);
  assert.equal(store.getSnapshot('20261103').entries[0].score, 19014.20);
  store.saveSnapshot(snapshot({capturedAt: '2026-11-02T17:01:00Z', entries: changed}));
  assert.equal(store.getSnapshot('20261103').entries[0].score, 19014.20);
});

test('snapshot timestamps cannot fabricate a prior day or mislabel manual data as 01:00', t => {
  const store = memory(t);
  for (const changes of [
    {date: '20261102'},
    {kind: 'manual'},
    {scheduledAt: null},
    {scheduledAt: '2026-11-02T18:00:00Z'},
    {capturedAt: '2026-11-02T16:59:59Z'},
    {capturedAt: '2026-11-03T17:00:00Z'},
    {capturedAt: '2026-11-03 01:00:00'},
    {capturedAt: '2026-02-30T01:00:00Z'},
  ]) assert.throws(() => store.saveSnapshot(snapshot(changes)), {code: 'RANK_SNAPSHOT'});
  assert.equal(store.latestSnapshot(), null);
});

test('follow lists are owner-scoped, idempotent, stable, and remove only exact identities', t => {
  const store = memory(t);
  const players = entries();
  assert.deepEqual(store.follow('qq:1', players), players);
  assert.equal(store.follow('qq:1', players).length, 3);
  store.follow('qq:2', [players[0]]);
  const sameTag = {...players[2], playerKey: 'name:OTHER#1477', gameId: 'OTHER', tag: '#1477'};
  store.follow('qq:1', [sameTag]);
  assert.equal(store.getFollows('qq:1').length, 4);
  assert.equal(store.unfollow('qq:1', [players[0].playerKey]).length, 3);
  assert.equal(store.getFollows('qq:1').at(-1).gameId, 'OTHER');
  assert.equal(store.getFollows('qq:2').length, 1);
  assert.deepEqual(store.getFollows('qq:3'), []);
});

test('follow batches validate fully before writing and updates preserve insertion order', t => {
  const store = memory(t);
  const players = entries();
  store.follow('qq:1', players);
  assert.throws(() => store.follow('qq:1', [{...players[0], gameId: 'RENAMED'}, {...players[1], tag: '#1'}]), {code: 'RANK_SNAPSHOT'});
  assert.equal(store.getFollows('qq:1')[0].gameId, 'SHAWN');
  store.follow('qq:1', [{...players[0], gameId: 'RENAMED'}]);
  assert.deepEqual(store.getFollows('qq:1').map(row => row.gameId), ['RENAMED', 'YINBEST', 'CHIPHANT']);
  assert.throws(() => store.unfollow('qq:1', [players[0].playerKey, null]), {code: 'RANK_SNAPSHOT'});
  assert.equal(store.getFollows('qq:1').length, 3);
});
