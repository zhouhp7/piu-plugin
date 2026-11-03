import test from 'node:test';
import assert from 'node:assert/strict';
import { loadImage } from '@napi-rs/canvas';
import { formatRankBasis, formatRankCaptureTime, formatRankRow, RANK_IMAGE_WIDTH, renderRankComparison } from '../src/rank-render.js';

const snapshot = { date: '20261103', capturedAt: '2026-11-02T17:00:03Z', kind: 'scheduled' };
const previous = { date: '20261026', capturedAt: '2026-10-25T17:00:04Z', kind: 'scheduled' };
const player = {
  playerKey: 'SHAWN#1477', gameId: 'SHAWN', tag: '#1477',
  current: { score: 19014.20, worldRank: 74, countryRank: 1, lastPlayedAt: '2026-11-01 13:05:44' },
  previous: { score: 19009.20, worldRank: 72, countryRank: 1, lastPlayedAt: '2026-10-25 13:05:44' },
};

test('score and rank comparisons use the right directions and two score decimals', () => {
  const row = formatRankRow(player);
  assert.equal(row.score, '19014.20');
  assert.equal(row.scoreDelta.text, '+5.00');
  assert.equal(row.worldDelta.text, '-2');
  assert.equal(row.countryDelta.text, '—');
  const up = formatRankRow({ ...player, previous: { ...player.previous, worldRank: 87, countryRank: 3 } });
  assert.equal(up.worldDelta.text, '+13');
  assert.equal(up.countryDelta.text, '+2');
  assert.notEqual(up.worldDelta.color, row.worldDelta.color);
});

test('no historical snapshot produces no fabricated NEW markers or numeric changes', () => {
  const row = formatRankRow({ ...player, previous: null, status: 'NEW' }, false);
  assert.equal(row.scoreDelta.text, '—');
  assert.equal(row.worldDelta.text, '—');
  assert.equal(row.countryDelta.text, '—');
  assert.equal(row.score, '19014.20');
});

test('missing players distinguish first seen, returned, absent and departed without zero scores', () => {
  const first = formatRankRow({ ...player, previous: null, status: 'NEW' });
  const back = formatRankRow({ ...player, previous: null, status: 'BACK' });
  const out = formatRankRow({ ...player, current: null });
  const missing = formatRankRow({ ...player, current: null, previous: null });
  assert.equal(first.scoreDelta.text, 'NEW');
  assert.equal(back.worldDelta.text, 'BACK');
  assert.equal(out.score, '—');
  assert.equal(out.worldRank, '未上榜');
  assert.equal(out.worldDelta.text, 'OUT');
  assert.equal(out.previousLastPlayed, true);
  assert.equal(missing.worldRank, '未上榜');
  assert.equal(missing.scoreDelta.text, '—');
  assert.equal(missing.lastPlayedAt, '—');
});

test('non-China players and null observations have no false country deltas', () => {
  const row = formatRankRow({ ...player, current: { ...player.current, countryRank: null, score: null }, previous: null });
  assert.equal(row.score, '—');
  assert.equal(row.countryRank, '—');
  assert.equal(row.countryDelta.text, '—');
  const paired = formatRankRow({ ...player, previous: { ...player.previous, score: null, worldRank: null, countryRank: null } });
  assert.equal(paired.scoreDelta.text, '—');
  assert.equal(paired.worldDelta.text, '—');
  assert.equal(paired.countryDelta.text, '—');
});

test('timestamps use GMT+8 independent of host and source display times stay unchanged', () => {
  assert.equal(formatRankCaptureTime('2026-11-02T17:00:03Z'), '2026-11-03 01:00:03');
  assert.equal(formatRankCaptureTime('2026-11-03T01:00:03+08:00'), '2026-11-03 01:00:03');
  assert.equal(formatRankCaptureTime(null), '时间未知');
  assert.equal(formatRankRow(player).lastPlayedAt, '2026-11-01 13:05:44');
});

test('full identity keeps zero-padded tags and does not repeat suffix in name', () => {
  const row = formatRankRow({ ...player, gameId: 'LONG NAME #0147', tag: '0147' });
  assert.equal(row.name, 'LONG NAME');
  assert.equal(row.tag, '#0147');
  assert.equal(row.identifier, 'LONG NAME#0147');
  assert.equal(formatRankRow({ ...player, gameId: 'SHAWN#1477' }).name, 'SHAWN');
  assert.equal(formatRankRow({ ...player, gameId: 'SHAWN#1477' }).identifier, 'SHAWN#1477');
});

test('default scope is explicitly followed-list ranking and country requires opt-in', () => {
  assert.equal(formatRankBasis().heading, '关注内名次*');
  assert.match(formatRankBasis().footnote, /本次关注名单/);
  assert.doesNotMatch(formatRankBasis().footnote, /中国/);
  assert.equal(formatRankBasis('country').heading, '中国名次*');
  assert.throws(() => formatRankBasis('guessed'), /rankBasis/);
});

test('followed-list ranks use explicit followRank without inferring a nationality', () => {
  const data = { ...player, current: { ...player.current, followRank: 2, countryRank: 30 }, previous: { ...player.previous, followRank: 5, countryRank: 21 } };
  const followed = formatRankRow(data);
  assert.equal(followed.countryRank, '2');
  assert.equal(followed.countryDelta.text, '+3');
  const country = formatRankRow(data, true, 'country');
  assert.equal(country.countryRank, '30');
  assert.equal(country.countryDelta.text, '-9');
  assert.equal(formatRankRow({ ...data, current: { ...data.current, followRank: null } }).countryRank, '—');
});

test('comparison and missing-baseline renders are real readable PNGs and preserve input order', async () => {
  const rows = [
    { ...player, gameId: '中文长名字 / A PLAYER NAME THAT WRAPS WITHOUT HIDING THE ID', current: null },
    player,
    { ...player, playerKey: 'FOREIGN#1477', gameId: 'FOREIGN', current: { ...player.current, worldRank: 20, countryRank: null }, previous: null },
  ];
  const before = JSON.stringify(rows);
  const bytes = await renderRankComparison({ current: snapshot, previous, rows });
  const image = await loadImage(bytes);
  assert.equal(Buffer.isBuffer(bytes), true);
  assert.equal(image.width, RANK_IMAGE_WIDTH);
  assert.ok(image.height >= 580);
  assert.equal(JSON.stringify(rows), before);
  const noHistory = await loadImage(await renderRankComparison({ current: { ...snapshot, kind: 'manual' }, previous: null, rows }));
  assert.equal(noHistory.width, RANK_IMAGE_WIDTH);
});

test('empty follow lists render and bad comparison metadata fails explicitly', async () => {
  const image = await loadImage(await renderRankComparison({ current: snapshot, rows: [] }));
  assert.equal(image.width, RANK_IMAGE_WIDTH);
  await assert.rejects(renderRankComparison({ rows: [] }), /current snapshot/);
  await assert.rejects(renderRankComparison({ current: snapshot, rows: {} }), /rows must be an array/);
  await assert.rejects(renderRankComparison({ current: snapshot, rankBasis: 'guessed' }), /rankBasis/);
});
