import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePumbility } from '../src/parser.js';

const fixture = await readFile(new URL('./fixtures/phoenix2.html', import.meta.url), 'utf8');
test('current Phoenix2 fixture preserves official contributions, grades, plates and chart digits', () => {
  const result = parsePumbility(fixture);
  assert.equal(result.pumbility, 4902.05);
  assert.equal(result.records.length, 18);
  assert.equal(result.records[0].title, 'Caprice of DJ Otada');
  assert.deepEqual([result.records[0].mode, result.records[0].level, result.records[0].rating], ['S', 21, 354.24]);
  assert.deepEqual([result.records[2].mode, result.records[2].level, result.records[2].grade, result.records[2].plate], ['D', 21, 'SS+', 'TG']);
  assert.equal(result.records.at(-1).rating, 0);
  assert.ok(result.records.every(record => record.score === null));
  assert.equal(Math.round(result.records.reduce((sum, record) => sum + record.rating, 0) * 100), 490205);
  assert.match(result.records[0].jacket, /^https:\/\/www\.piugame\.com\/data\/song_img2\//);
});
test('S+ stays S+ and a title containing separators retains the whole title', () => {
  const html = fixture.replace('/grade/ss.png', '/grade/s_p.png').replace('Caprice of DJ Otada - Banya Production', 'Exceed2 Opening - SHORT CUT - - BanYa');
  const record = parsePumbility(html).records[0];
  assert.equal(record.grade, 'S+');
  assert.equal(record.title, 'Exceed2 Opening - SHORT CUT -');
});
test('failed-stage grade retains its source code and an explicit failed flag', () => {
  const record = parsePumbility(fixture.replace('/grade/ss.png', '/grade/x_aa_p.png')).records[0];
  assert.equal(record.grade, 'AA+');
  assert.equal(record.gradeCode, 'X_AA+');
  assert.equal(record.failed, true);
  assert.equal(parsePumbility(fixture).records[0].failed, false);
});
test('legacy Phoenix row uses its contribution as rating, not play score', () => {
  const result = parsePumbility(`<div class="pumbility_total_wrap"><div class="inn"><p class="t1">PUMBILITY</p><p class="t2">12,345</p></div></div><div class="pumblitiySt"><ul class="list"><li><div class="profile_name"><p class="t1">Legacy Song</p></div><div class="score"><i class="tt">1,234</i></div></li></ul></div>`);
  assert.equal(result.pumbility, 12345);
  assert.equal(result.records[0].rating, 1234);
  assert.equal(result.records[0].score, null);
});
test('login/changed/partial pages fail instead of fabricating an empty B50', () => {
  assert.throws(() => parsePumbility('<form id="login_fs"><input name="mb_password"></form>'), {code:'AUTH_REQUIRED'});
  assert.throws(() => parsePumbility('<h1>maintenance</h1>'), {code:'PAGE_CHANGED'});
  assert.throws(() => parsePumbility('<div class="pumbility_total_wrap"><div class="score">123.4</div></div>'), {code:'PAGE_CHANGED'});
  assert.throws(() => parsePumbility(fixture.replace('354<span', 'broken<span')), {code:'PAGE_CHANGED'});
});
test('a real zero-total empty profile and pagination are supported', () => {
  const result = parsePumbility('<div class="pumbility_total_wrap"><div class="score">0.00</div></div><div class="board_paging"><button onclick="location.href=\'?page=3\'">last</button></div>');
  assert.equal(result.pumbility, 0);
  assert.deepEqual(result.records, []);
  assert.equal(result.lastPage, 3);
});
