import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {load} from 'cheerio';
import {parseProfileMeta,normalizeProfileMeta} from '../src/profile-meta.js';
import {parsePumbility,parseRecent} from '../src/parser.js';
import {parsePlayData} from '../src/play-data.js';
import {normalizeProfile} from '../src/model.js';
import {formatShanghaiTime} from '../src/time-format.js';
import {GRADE_CODES,PLATE_CODES} from '../src/assets.js';

function header({date='2026-11-02 21:46:54',title='[P.B] BRONZE',arcade='WenZhou DiYiHuiHe'}={}) {
  return `<div class="subProfile_wrap"><div class="profile_name"><div class="name_w">
    <p class="t1 en col1">${title}</p><p class="t2 en">ALPHA #1001</p></div><div class="time_w"><ul>
    <li><i class="tt">Last Access Date : ${date}</i></li>
    <li><i class="tt">Recently Access Games : ${arcade}</i></li></ul></div></div></div>`;
}
const expected={equippedTitle:'[P.B] BRONZE',lastAccessAt:'2026-11-02T12:46:54.000Z',lastArcade:'WenZhou DiYiHuiHe'};

test('profile metadata reads the current header and converts unzoned official time from GMT+9',()=>{
  const html=header()+'<div id="profile_modal"><div class="name_w"><p class="t1">WRONG TITLE</p></div><div class="time_w"><li>Recently Access Games : WRONG ARCADE</li></div></div>';
  assert.deepEqual(parseProfileMeta(html),expected);
  assert.deepEqual(parseProfileMeta(load(html)),expected);
  assert.equal(formatShanghaiTime(parseProfileMeta(html).lastAccessAt),'2026-11-02 20:46:54 GMT+8');
});

test('official access dates handle midnight, year changes and leap days independently of host timezone',()=>{
  assert.equal(parseProfileMeta(header({date:'2027-01-01 00:30:00'})).lastAccessAt,'2026-12-31T15:30:00.000Z');
  assert.equal(formatShanghaiTime(parseProfileMeta(header({date:'2027-01-01 00:30:00'})).lastAccessAt),'2026-12-31 23:30:00 GMT+8');
  assert.equal(parseProfileMeta(header({date:'2024-02-29 09:01:02'})).lastAccessAt,'2024-02-29T00:01:02.000Z');
  assert.equal(parseProfileMeta(header({date:'2026-11-02 21:46:54 (GMT+9)'})).lastAccessAt,expected.lastAccessAt);
});

test('invalid or absent official access dates stay missing without rolling into another day',()=>{
  for(const date of ['', '-', 'not-a-date', '2026-02-29 12:00:00', '2026-02-30 12:00:00',
    '2026-04-31 12:00:00', '2026-00-01 12:00:00', '2026-13-01 12:00:00', '2026-01-00 12:00:00',
    '2026-01-01 24:00:00', '2026-01-01 12:60:00', '2026-01-01 12:00:60', '0000-01-01 12:00:00',
    '2026-11-02 21:46:54 (GMT+8)']) {
    const result=parseProfileMeta(header({date}));
    assert.equal(result.lastAccessAt,null,date);
    assert.equal(result.equippedTitle,expected.equippedTitle);
    assert.equal(result.lastArcade,expected.lastArcade);
  }
  for(const value of [null,undefined,'<h1>empty</h1>']) {
    assert.deepEqual(parseProfileMeta(value),{equippedTitle:null,lastAccessAt:null,lastArcade:null});
  }
});

test('title and arcade text keep Unicode and punctuation while whitespace and lengths are bounded',()=>{
  const result=parseProfileMeta(header({title:'  [P.B]\n  白银 / Silver  ',arcade:'  温州\t 第一回合 / Tokyo &amp; Ω  '}));
  assert.equal(result.equippedTitle,'[P.B] 白银 / Silver');
  assert.equal(result.lastArcade,'温州 第一回合 / Tokyo & Ω');
  const bounded=normalizeProfileMeta({equippedTitle:'😀'.repeat(130),lastArcade:'机'.repeat(220)});
  assert.equal([...bounded.equippedTitle].length,120);
  assert.equal([...bounded.lastArcade].length,200);
  assert.equal(normalizeProfileMeta({equippedTitle:12,lastArcade:{name:'invalid'}}).equippedTitle,null);
});

test('normalization keeps only explicit valid zoned access times and rejects invalid calendars',()=>{
  assert.equal(normalizeProfileMeta({lastAccessAt:'2026-11-02T21:46:54+09:00'}).lastAccessAt,expected.lastAccessAt);
  assert.equal(normalizeProfileMeta({lastAccessAt:new Date(expected.lastAccessAt)}).lastAccessAt,expected.lastAccessAt);
  assert.equal(normalizeProfileMeta({lastAccessAt:'2026-11-02T12:46:54.12Z'}).lastAccessAt,'2026-11-02T12:46:54.120Z');
  for(const lastAccessAt of ['2026-11-02 21:46:54','2026-02-30T00:00:00Z','2026-01-01T24:00:00Z',
    '2026-11-02T21:46:54+14:01','2026-11-02T21:46:54+09:60',new Date('invalid'),0]) {
    assert.equal(normalizeProfileMeta({lastAccessAt}).lastAccessAt,null);
  }
});

test('Pumbility, recent and Play Data parse the same metadata and model retains it without relaxing name validation',async()=>{
  const fixture=await readFile(new URL('./fixtures/phoenix2.html',import.meta.url),'utf8');
  const pumbility=parsePumbility(fixture.replace('<body>',`<body>${header()}`));
  const recent=parseRecent(header()+'<div class="recently_playe_wrap"><ul class="recently_playeList"></ul></div>');
  const section=(codes,grade)=>`<div class="plate_w ${grade?'grade':''}"><ul class="list">${codes.map(code=>
    `<li><div class="list_in"><div class="img"><img src="/l_img/p2/${grade?'grade':'plate'}/${grade?'':'s_'}${code.toLowerCase().replace('+','_p')}.png"></div><i class="t_num">0 / 100</i></div></li>`).join('')}</ul></div>`;
  const data=parsePlayData(header()+'<div class="playData_tw"><div class="total"><i class="t2">0</i></div></div>'+`<div class="play_data_wrap">${section(GRADE_CODES,true)}${section(PLATE_CODES,false)}</div>`);
  for(const profile of [pumbility,recent,data]) {
    assert.equal(profile.playerName,'ALPHA#1001');
    for(const key of Object.keys(expected)) assert.equal(profile[key],expected[key]);
  }
  const normalized=normalizeProfile({...pumbility,playerName:'alpha#1001'});
  for(const key of Object.keys(expected)) assert.equal(normalized[key],expected[key]);
  assert.throws(()=>normalizeProfile({...pumbility,playerName:'A B#1001'}),{code:'GAME_ID_FORMAT'});
});
