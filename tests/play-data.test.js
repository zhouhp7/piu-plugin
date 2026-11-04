import test from 'node:test';
import assert from 'node:assert/strict';
import {loadImage} from '@napi-rs/canvas';
import vm from 'node:vm';
import {GRADE_CODES,PLATE_CODES} from '../src/assets.js';
import {parsePlayData,renderPlayData,DATA_IMAGE_WIDTH} from '../src/play-data.js';
import {fetchPlayData} from '../src/client.js';

function dataPage({name='ALPHA #1001',playCount='42',total='100',missing=false,duplicate=false,badCount=false}={}) {
  const section=(codes,grade)=>`<div class="plate_w ${grade?'grade':''}"><ul class="list">${codes.map((code,index)=>{
    const file=code.toLowerCase().replace('+','_p');
    const value=badCount&&index===0?'101':String(index);
    return `<li><div class="list_in"><div class="img"><img src="/l_img/p2/${grade?'grade':'plate'}/${grade?'':'s_'}${file}.png"></div>
      <i class="t_num">${value} / ${total}</i></div></li>`;
  }).join('')}</ul></div>`;
  const grades=[...GRADE_CODES].reverse();
  if(missing)grades.pop();
  if(duplicate)grades[1]=grades[0];
  return `<div class="subProfile_wrap"><div class="name_w"><p class="t2">${name}</p></div></div>
    <div class="board_search playData_tw"><div class="total"><i class="t2">${playCount}</i><i class="tt">Freeplay mode is not counted.</i></div>
    <select><option value="">All</option></select></div><div class="play_data_wrap">${section(grades,true)}${section([...PLATE_CODES].reverse(),false)}</div>`;
}

test('Play Data retains all Grade and Plate counts, totals and profile without summing rows',()=>{
  const profile=parsePlayData(dataPage({playCount:'1,234',total:'4,704'}));
  assert.equal(profile.playerName,'ALPHA#1001');
  assert.equal(profile.playCount,1234);
  assert.equal(profile.totalCharts,4704);
  assert.equal(profile.grades.length,16);
  assert.equal(profile.plates.length,8);
  assert.equal(profile.grades[0].code,'SSS+');
  assert.equal(profile.grades[0].count,0);
  assert.equal(profile.plates[0].code,'PG');
  assert.equal(profile.filterLabel,'All');
  assert.match(profile.playCountNote,/Freeplay/);
  assert.equal(profile.pumbility,null);
});
test('Play Data canonicalizes valid profile names and rejects forbidden name characters',()=>{
  assert.equal(parsePlayData(dataPage({name:' \talPha \n # 1001 '})).playerName,'ALPHA#1001');
  for(const name of ['A B#1001','A\tB#1001','A\nB#1001','ABCDEFGHIJKLM#1001','ALPHA_#1001','名字#1001','ＡLPHA#1001']){
    assert.throws(()=>parsePlayData(dataPage({name})),{code:'GAME_ID_FORMAT'});
  }
});
test('Play Data fails on expired login, absent rows, duplicates and invalid counts',()=>{
  assert.throws(()=>parsePlayData('<form id="login_fs"><input name="mb_password"></form>'),{code:'AUTH_REQUIRED'});
  assert.throws(()=>parsePlayData('<h1>maintenance</h1>'),{code:'PAGE_CHANGED'});
  for(const options of [{missing:true},{duplicate:true},{badCount:true},{playCount:'unknown'}]) {
    assert.throws(()=>parsePlayData(dataPage(options)),{code:'PAGE_CHANGED'});
  }
});
test('Play Data renders original badges and safe zero counts into a complete image',async()=>{
  const profile=parsePlayData(dataPage());
  profile.updatedAt='2026-11-02T16:43:19Z';
  const jpeg=await renderPlayData(profile);
  assert.equal(jpeg.readUInt16BE(0),0xffd8);
  const image=await loadImage(jpeg);
  assert.equal(image.width,DATA_IMAGE_WIDTH);
  assert.equal(image.width,1200);
  assert.equal(image.height,1139);
});

function account({initial='222',broken=false,mismatch=false,redirected=false,lowercaseData=false}={}) {
  let active=initial,location='about:blank',closed=false;
  const switches=[],cards=[{id:'111',name:'ALPHA #1001'},{id:'222',name:'BETA #2002'}];
  const page={
    url:()=>location,
    async goto(url){location=redirected&&url.includes('play_data.php')?'https://www.piugame.com/bbs/login.php':url;return {ok:()=>true};},
    async content(){
      const card=cards.find(item=>item.id===active);
      if(location.includes('play_data.php'))return broken?'<h1>maintenance</h1>':dataPage({name:mismatch?'EXTERNAL #9999':lowercaseData?card.name.toLowerCase():card.name});
      return `<div class="subProfile_wrap"><div class="name_w"><p class="t2">${card.name}</p></div></div>
        <div id="profile_modal">${cards.map(item=>`<div class="in_profile"><input name="sub_profile" value="${item.id}" ${item.id===active?'checked':''}>
        <div class="name_w"><p class="t2">${item.name}</p></div></div>`).join('')}</div><div class="pumbility_total_wrap"><div class="score">0</div></div>`;
    },
    async evaluate(fn,id){return vm.runInNewContext(`(${fn.toString()})(id)`,{id,URLSearchParams,AbortSignal,
      fetch:async(url,options)=>{assert.equal(url,'/ajax/sub_profile.php');active=new URLSearchParams(options.body).get('no');switches.push(active);return {ok:true};}});},
  };
  return {switches,active:()=>active,closed:()=>closed,
    manager:{context:async()=>({newPage:async()=>page,storageState:async()=>({cookies:[],origins:[]}),close:async()=>{closed=true;}})}};
}
test('Play Data selects first or explicit owned profile and restores the selected website card',async()=>{
  const first=account(),result=await fetchPlayData(first.manager,{});
  assert.equal(result.profile.playerName,'ALPHA#1001');
  assert.equal(result.profile.pumbility,0);
  assert.deepEqual(first.switches,['111','222']);
  assert.equal(first.active(),'222');
  assert.equal(first.closed(),true);
  const explicit=account({initial:'111'});
  assert.equal((await fetchPlayData(explicit.manager,{}, {gameId:'BETA#2002'})).profile.playerName,'BETA#2002');
  assert.deepEqual(explicit.switches,['222','111']);
  const foreign=account();
  await assert.rejects(fetchPlayData(foreign.manager,{}, {gameId:'EXTERNAL#9999'}),{code:'GAME_ID_NOT_FOUND'});
  assert.deepEqual(foreign.switches,[]);
});
test('Play Data restores the prior profile after bad pages, mismatched identities or expired auth',async()=>{
  for(const [options,code] of [[{broken:true},'PAGE_CHANGED'],[{mismatch:true},'GAME_ID_SWITCH_FAILED'],[{redirected:true},'AUTH_REQUIRED']]){
    const current=account(options);
    await assert.rejects(fetchPlayData(current.manager,{}),{code});
    assert.deepEqual(current.switches,['111','222']);
    assert.equal(current.active(),'222');assert.equal(current.closed(),true);
  }
});
test('Play Data and Pumbility profile headers compare using canonical uppercase identities',async()=>{
  const current=account({initial:'111',lowercaseData:true});
  const result=await fetchPlayData(current.manager,{}, {gameId:'bEtA#2002'});
  assert.equal(result.profile.playerName,'BETA#2002');
  assert.deepEqual(current.switches,['222','111']);
  assert.equal(current.active(),'111');assert.equal(current.closed(),true);
});
