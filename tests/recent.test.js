import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseRecent} from '../src/parser.js';
import {fetchRecent} from '../src/client.js';

const escaped = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function row({title = 'Repeated Song', score = '984,196', grade = 'ss', plate = 'tg',
  mode = 's', level = 18, date = '2026-11-03 00:30:06 (GMT+9)'} = {}) {
  return `<li><div class="wrap_in"><div class="in bgfix"><div class="con1"><div class="song_name"><p>${escaped(title)}</p></div></div>
    <div class="con2"><ul><li><div class="stepBall_in"><div class="tw"><img src="/stepball/${mode}_text.png"></div>
      <div class="numw">${[...String(level)].map(digit => `<img src="/stepball/${mode}_num_${digit}.png">`).join('')}</div></div></li>
      <li><div class="li_in ac"><img src="${grade ? `/l_img/p2/grade/${grade}.png` : ''}"><i class="tx">${score}</i></div></li>
      ${plate ? `<li><img src="/l_img/p2/plate/${plate}.png"></li>` : ''}</ul></div>
    <div class="con3"><table><tr>${['PERFECT','GREAT','GOOD','BAD','MISS'].map((label,i) =>
      `<td data-th="${label}"><div class="tx">${i === 0 ? '1,000' : i}</div></td>`).join('')}</tr></table></div>
    </div><p class="recently_date_tt">${date}</p></div></li>`;
}
function document(rows, name = 'ALPHA #1001') {
  return `<div class="subProfile_wrap"><div class="name_w"><p class="t2">${name}</p></div></div>
    <div class="recently_playe_wrap"><ul class="recently_playeList">${rows}</ul></div>`;
}

test('recent preserves play order, repeated charts, raw scores, judgements and zoned dates', () => {
  const profile = parseRecent(document(row() + row({score:'980,000',date:'2026-11-02 23:30:00 (GMT+9)'}) +
    row({title:'Dual Racing <RED vs BLUE>',mode:'d',level:19,grade:'sss_p',plate:'ug'})));
  assert.equal(profile.kind, 'recent');
  assert.equal(profile.playerName, 'ALPHA#1001');
  assert.equal(profile.pumbility, null);
  assert.equal(profile.records.length, 3);
  assert.deepEqual(profile.records.map(record => record.rank), [1,2,3]);
  assert.deepEqual(profile.records.slice(0,2).map(record => record.title), ['Repeated Song','Repeated Song']);
  assert.equal(profile.records[0].score, 984196);
  assert.equal(profile.records[0].rating, null);
  assert.equal(profile.records[0].playedAt, '2026-11-02T15:30:06.000Z');
  assert.equal(profile.records[0].playedAtSource, '2026-11-03 00:30:06 (GMT+9)');
  assert.deepEqual(profile.records[0].judgements, {perfect:1000,great:1,good:2,bad:3,miss:4});
  assert.equal(profile.records[2].title, 'Dual Racing <RED vs BLUE>');
  assert.equal(profile.records[2].mode, 'D');
  assert.equal(profile.records[2].level, 19);
  assert.equal(profile.records[2].grade, 'SSS+');
  assert.equal(profile.records[2].plate, 'UG');
});

test('recent keeps failed grades, stage breaks and a legitimate zero score distinct', () => {
  const records = parseRecent(document(row({grade:'x_a',plate:null,score:'853,620'}) +
    row({grade:null,plate:null,score:'STAGE BREAK'}) + row({grade:'a',score:'0'}))).records;
  assert.equal(records[0].grade, 'A');
  assert.equal(records[0].gradeCode, 'X_A');
  assert.equal(records[0].failed, true);
  assert.equal(records[0].score, 853620);
  assert.equal(records[1].stageBreak, true);
  assert.equal(records[1].failed, true);
  assert.equal(records[1].score, null);
  assert.equal(records[1].rating, null);
  assert.equal(records[2].score, 0);
  assert.equal(records[2].stageBreak, false);
});

test('recent accepts a real empty list and caps the available plays at fifty without deduplication', () => {
  assert.equal(parseRecent(document('')).records.length, 0);
  const records = parseRecent(document(Array.from({length:52}, () => row()).join(''))).records;
  assert.equal(records.length, 50);
  assert.equal(records.at(-1).rank, 50);
});

test('recent rejects expired login, changed markup, malformed scores and invalid zoned dates', () => {
  assert.throws(() => parseRecent('<form id="login_fs"><input name="mb_password"></form>'), {code:'AUTH_REQUIRED'});
  assert.throws(() => parseRecent('<h1>maintenance</h1>'), {code:'PAGE_CHANGED'});
  for (const options of [{score:'not a score'}, {score:'1,000,001'}, {score:'0.5'},
    {date:'2026-02-30 12:00:00 (GMT+9)'}, {date:'2026-11-03 12:00:00'}, {mode:'unrecognized'}]) {
    assert.throws(() => parseRecent(document(row(options))), {code:'PAGE_CHANGED'});
  }
  assert.throws(() => parseRecent(document(row().replace('data-th="MISS"','data-th="OTHER"'))), {code:'PAGE_CHANGED'});
});

function account({initial = '222', broken = false, mismatch = false, redirected = false} = {}) {
  let active = initial, location = 'about:blank', closed = false;
  const switches = [];
  const cards = [{id:'111',name:'ALPHA #1001'},{id:'222',name:'BETA #2002'}];
  const page = {
    url: () => location,
    async goto(url) {location = redirected && url.includes('recently_played') ? 'https://www.piugame.com/bbs/login.php' : url; return {ok:()=>true};},
    async content() {
      const current = cards.find(card => card.id === active);
      if (location.includes('recently_played')) return broken ? '<h1>maintenance</h1>' : document(row(), mismatch ? 'OUTSIDE #9999' : current.name);
      return `<div class="subProfile_wrap"><div class="name_w"><p class="t2">${current.name}</p></div></div>
        <div id="profile_modal">${cards.map(card => `<div class="in_profile"><input name="sub_profile" value="${card.id}" ${card.id===active?'checked':''}>
          <div class="name_w"><p class="t2">${card.name}</p></div></div>`).join('')}</div>
        <div class="pumbility_total_wrap"><div class="score">0</div></div>`;
    },
    async evaluate(fn, id) {
      return vm.runInNewContext(`(${fn.toString()})(id)`, {id,URLSearchParams,AbortSignal,
        fetch: async (url, options) => {
          assert.equal(url, '/ajax/sub_profile.php');
          active = new URLSearchParams(options.body).get('no'); switches.push(active); return {ok:true};
        }});
    },
  };
  const manager = {context:async()=>({newPage:async()=>page,storageState:async()=>({cookies:[],origins:[]}),close:async()=>{closed=true;}})};
  return {manager,switches,active:()=>active,closed:()=>closed};
}

test('recent defaults to first owned profile, supports full selectors and restores website selection', async () => {
  const first = account();
  const result = await fetchRecent(first.manager, {});
  assert.equal(result.profile.playerName, 'ALPHA#1001');
  assert.deepEqual(first.switches, ['111','222']);
  assert.equal(first.active(), '222');
  assert.equal(first.closed(), true);
  const explicit = account({initial:'111'});
  assert.equal((await fetchRecent(explicit.manager, {}, {gameId:'BETA#2002'})).profile.playerName, 'BETA#2002');
  assert.deepEqual(explicit.switches, ['222','111']);
  const foreign = account();
  await assert.rejects(fetchRecent(foreign.manager, {}, {gameId:'OUTSIDE#9999'}), {code:'GAME_ID_NOT_FOUND'});
  assert.deepEqual(foreign.switches, []);
});

test('recent restores selection on failed parsing, wrong profile and login redirection', async () => {
  for (const [options, code] of [[{broken:true},'PAGE_CHANGED'], [{mismatch:true},'GAME_ID_SWITCH_FAILED'], [{redirected:true},'AUTH_REQUIRED']]) {
    const current = account(options);
    await assert.rejects(fetchRecent(current.manager, {}), {code});
    assert.deepEqual(current.switches, ['111','222']);
    assert.equal(current.active(), '222');
    assert.equal(current.closed(), true);
  }
});
