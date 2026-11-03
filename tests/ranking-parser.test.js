import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRankingPage, auditRanking, rankingPlayerKey} from '../src/ranking-parser.js';

const row = ({name = 'ALPHA', tag = '#1001', rank = 4, medal, score = '19,014<span>.20</span>', time = '2026-11-03 01:23:45 (GMT+9)', hidden = false} = {}) =>
  `<li${hidden ? ' style="display:none"' : ''}><div class="num">${medal ? `<img src="/l_img/${medal}medal.png">` : `<i class="tt">${rank}</i>`}</div><div class="profile_name pl0">${name}</div><div class="profile_name st1">${tag}</div><div class="score"><i class="tt">${score}</i></div><div class="date"><i class="tt">${time}</i></div></li>`;
const wrap = content => `<html><body><ul class="list pumbilitySt">${content}</ul></body></html>`;

test('medals, decimal spans and hidden rows retain official ranks and complete identities', () => {
  const result = parseRankingPage(wrap(row({name: 'ONE', medal: 'gold'}) + row({name: 'TWO', medal: 'silver'}) + row({name: 'THREE', medal: 'bronze', hidden: true})));
  assert.deepEqual(result.entries.map(entry => entry.worldRank), [1, 2, 3]);
  assert.equal(result.entries[0].score, 19014.20);
  assert.equal(result.entries[2].playerKey, 'game:THREE#1001');
  assert.equal(result.entries[0].country, null);
  assert.equal(result.nextPage, null);
  assert.equal(result.sourceUpdatedAt, null);
});

test('the personal ranking copy is ignored and official tied/gapped ranks are preserved', () => {
  const personal = `<div class="my_pumblitiy_wrap"><ul class="pumbilitySt">${row({name: 'ME', rank: 9000})}</ul></div>`;
  const result = parseRankingPage(personal + wrap(row({name: 'A', rank: 4}) + row({name: 'B', rank: 4}) + row({name: 'C', rank: 6})));
  assert.deepEqual(result.entries.map(entry => entry.worldRank), [4, 4, 6]);
  assert.equal(result.entries.length, 3);
});

test('explicit source offsets convert to UTC without interpreting unzoned dates', () => {
  const result = parseRankingPage(wrap(row({name: 'PLUS', rank: 1}) + row({name: 'MINUS', rank: 2, time: '2026-11-03 01:23:45 (GMT-3:30)'}) + row({name: 'RAW', rank: 3, time: '2026-11-03 01:23:45'}) + row({name: 'NONE', rank: 4, time: '-'})));
  assert.equal(result.entries[0].lastPlayedAt, '2026-11-02T16:23:45.000Z');
  assert.equal(result.entries[1].lastPlayedAt, '2026-11-03T04:53:45.000Z');
  assert.equal(result.entries[2].lastPlayedAt, '2026-11-03 01:23:45');
  assert.equal(result.entries[3].lastPlayedAt, null);
  assert.equal(result.entries[0].lastPlayedSource, '2026-11-03 01:23:45 (GMT+9)');
  assert.throws(() => parseRankingPage(wrap(row({time: '2026-02-30 01:00:00 (GMT+9)'}))), {code: 'RANKING_PAGE_CHANGED'});
});

test('repeated tags are allowed, audited and never collapse different complete names', () => {
  const entries = parseRankingPage(wrap(row({name: 'ALPHA', rank: 1}) + row({name: 'BETA', rank: 2}) + row({name: 'OTHER', tag: '#2002', rank: 3}))).entries;
  const audit = auditRanking(entries);
  assert.equal(audit.count, 3);
  assert.equal(audit.duplicateTagCount, 1);
  assert.equal(audit.affectedPlayers, 2);
  assert.deepEqual(audit.duplicateTags[0].players.map(entry => entry.playerKey), ['game:ALPHA#1001', 'game:BETA#1001']);
  assert.notEqual(rankingPlayerKey('Alpha', '#1001'), rankingPlayerKey('ALPHA', '#1001'));
  assert.equal(rankingPlayerKey('e\u0301', '#1001'), 'game:é#1001');
});

test('login, malformed, duplicate-full-identity and out-of-order pages fail closed', () => {
  assert.throws(() => parseRankingPage('<form id="login_fs"><input name="mb_password"></form>'), {code: 'AUTH_REQUIRED'});
  assert.throws(() => parseRankingPage('<h1>maintenance</h1>'), {code: 'RANKING_PAGE_CHANGED'});
  for (const content of [row({tag: '#12'}), row({score: 'not a score'}), row({rank: 0}), row() + row(), row({name: 'A', rank: 5}) + row({name: 'B', rank: 4})]) {
    assert.throws(() => parseRankingPage(wrap(content)), {code: 'RANKING_PAGE_CHANGED'});
  }
});

test('explicit next-page controls are parsed without treating the last-page link as next', () => {
  const html = wrap(row()) + '<div class="board_paging"><button onclick="location.href=\'?t=&amp;page=3\'"><i class="xi next"></i></button><a href="?page=10"><i class="xi last"></i></a></div>';
  assert.equal(parseRankingPage(html, {page: 2}).nextPage, 3);
  assert.equal(parseRankingPage(html, {page: 3}).nextPage, null);
});
