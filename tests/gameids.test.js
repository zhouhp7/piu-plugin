import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGameIds,resolveGameId,normalizeGameIdSelector,normalizeGameIdName} from '../src/parser.js';
import {fetchGameIds,fetchProfile,readAccount} from '../src/client.js';
import vm from 'node:vm';
import {titlePage} from './helpers/title-page.js';

const html=`<div class="subProfile_wrap"><div class="name_w"><p class="t2">ALPHA #1001</p></div></div>
 <div id="game_id_change_modal"><form action="/ajax/user_game_id_change.php"><input name="game_id_change"></form></div>
 <div id="profile_modal">
  <div class="in_profile"><label><input type="radio" name="sub_profile" value="111" checked><div class="name_w"><p class="t2">ALPHA #1001</p></div></label></div>
  <div class="in_profile"><label><input type="radio" name="sub_profile" value="222"><div class="name_w"><p class="t2">BETA #2002</p></div></label></div>
  <div class="in_profile"><label><input type="radio" name="sub_profile" value="333"><div class="name_w"><p class="t2">BETA #3003</p></div></label></div>
 </div>`;
test('account cards use internal switch IDs and preserve visible names/tags/current card',()=>{
 const cards=parseGameIds(html);
 assert.equal(cards.length,3);
 assert.deepEqual(cards[0],{id:'111',uid:'uid1',playerName:'ALPHA#1001',gameId:'ALPHA',tag:'#1001',selected:true});
 assert.equal(cards[1].id,'222');
 assert.equal(cards[1].selected,false);
 assert.equal(resolveGameId(cards).id,'111');
});
test('official card switching resolves canonical full identifiers and rejects malformed switches',()=>{
 const cards=parseGameIds(html);
 for(const query of ['beta #2002','BETA#2002',' BETA  # 2002 '])assert.equal(resolveGameId(cards,query).id,'222');
 assert.deepEqual(cards.map(card=>card.uid),['uid1','uid2','uid3']);
 assert.equal(resolveGameId(cards,'ALPHA#1001').id,'111');
 for(const value of ['222','BETA','#2002','2002','uid0','uid2','UID2','uid9999','ALPHA#123','ALPHA#12345','A#B#1234']) {
  assert.throws(()=>resolveGameId(cards,value),{code:'GAME_ID_FORMAT'});
 }
 assert.throws(()=>resolveGameId(cards,'FOREIGN #9999'),{code:'GAME_ID_NOT_FOUND'});
 assert.equal(normalizeGameIdSelector(' shawn  # 1477 '),'SHAWN#1477');
 assert.throws(()=>normalizeGameIdSelector(' SHA WN  # 1477 '),{code:'GAME_ID_FORMAT'});
 const repeatedTag=cards.map((card,index)=>index===1?{...card,tag:'#1001',playerName:'BETA#1001'}:card);
 assert.equal(resolveGameId(repeatedTag,'BETA#1001').id,'222');
 const caseVariants=[{id:'one',playerName:'Alice#1001'},{id:'two',playerName:'ALICE#1001'}];
 for(const value of ['Alice#1001','ALICE#1001','aLiCe#1001']) {
  assert.throws(()=>resolveGameId(caseVariants,value),{code:'GAME_ID_AMBIGUOUS'});
 }
});

test('profile names accept only 1–12 ASCII letters and digits and canonicalize case',()=>{
 for(const [value,expected] of [['a','A'],['0','0'],['abc123XYZ789','ABC123XYZ789'],[' \tZaNtInG\n ','ZANTING']]){
  assert.equal(normalizeGameIdName(value),expected);
 }
 for(const name of ['', ' ', 'ABCDEFGHIJKLM', 'A B', 'A\tB', 'A\nB', 'A\u00a0B', 'A\u200bB',
  'ALPHA_', 'ALPHA-BETA', '名字', 'Café', 'ＡLPHA', 'ALPHA😀', null, undefined, 123]) {
  assert.throws(()=>normalizeGameIdName(name),{code:'GAME_ID_FORMAT'});
 }
 assert.equal(normalizeGameIdSelector(' \tzanting \n # \t9403  '),'ZANTING#9403');
 for(const value of ['ALPHA#１２３４','ALPHA#١٢٣٤','ALPHA#12 34','A B#1001','A\nB#1001','ABCDEFGHIJKLM#1001']){
  assert.throws(()=>normalizeGameIdSelector(value),{code:'GAME_ID_FORMAT'});
 }
});
test('rename inputs, malformed IDs and repeated cards cannot become switch targets',()=>{
 assert.equal(parseGameIds('<form><input name="sub_profile" value="111"></form>').length,0);
 assert.equal(parseGameIds(html.replace('value="222"','value="../../admin"')).length,2);
 assert.equal(parseGameIds(html.replace('value="333"','value="222"')).length,2);
 for(const name of ['A B','A\tB','A\nB','ABCDEFGHIJKLM','BETA_','名字','Café','ＡLPHA']) {
  assert.equal(parseGameIds(html.replaceAll('BETA #2002',`${name} #2002`)).length,2);
 }
 const mixed=parseGameIds(html.replaceAll('ALPHA','aLpHa').replace('value="111" checked','value="111"'));
 assert.equal(mixed[0].playerName,'ALPHA#1001');assert.equal(mixed[0].gameId,'ALPHA');
 assert.equal(mixed[0].selected,true,'current profile display matching ignores letter case');
});

function fakeAccount({breakTarget=false, failTargetNavigation=false, invalidSelection=false, multipleSelection=false, initial='111', brokenTitle=false, mismatchedTitle=false, redirectedTitle=false, lowercaseTitle=false}={}) {
 let active=initial,domActive=initial,closed=false,currentUrl='about:blank';
 const switches=[];
 const cards=[{id:'111',name:'ALPHA #1001',total:100},{id:'222',name:'BETA #2002',total:200},{id:'333',name:'EMPTY #3003',total:0}];
 const page={
  url:()=>currentUrl,
  goto:async url=>{
   if(failTargetNavigation&&active==='222')throw new Error('Navigation failed after POST');
   currentUrl=redirectedTitle&&url.includes('/title.php')?'https://www.piugame.com/bbs/login.php':url;domActive=active;return{ok:()=>true};
  },
  content:async()=>{
   const card=cards.find(c=>c.id===domActive);
   if(currentUrl.includes('/title.php'))return brokenTitle?'<h1>maintenance</h1>':titlePage(mismatchedTitle?'WRONG#9999':lowercaseTitle?card.name.toLowerCase():card.name,{single:14000+card.total,double:17000+card.total});
   const modal=`<div id="profile_modal">${cards.map(c=>`<div class="in_profile"><input name="sub_profile" value="${c.id}" ${!invalidSelection&&(c.id===domActive||(multipleSelection&&c.id==='333'))?'checked':''}><div class="name_w"><p class="t2">${c.name}</p></div></div>`).join('')}</div>`;
   if(breakTarget&&active==='222')return modal+'<h1>maintenance</h1>';
   return `<div class="subProfile_wrap"><div class="name_w"><p class="t2">${invalidSelection?'OUTSIDE #9999':card.name}</p></div></div>${modal}<div class="pumbility_total_wrap"><div class="score">${card.total}</div></div>`+
    (card.total?`<ul><li><div class="top-wrap"></div><div class="mid-wrap">Song ${card.id} - Artist</div><div class="bottom-wrap"><div class="score">${card.total}</div></div></li></ul>`:'');
  },
  evaluate:async(fn,id)=>vm.runInNewContext(`(${fn.toString()})(id)`,{id,URLSearchParams,AbortSignal,
   fetch:async(path,options)=>{
    assert.equal(path,'/ajax/sub_profile.php');
    assert.equal(options.method,'POST');
    const target=new URLSearchParams(options.body).get('no');
    assert.ok(cards.some(c=>c.id===target));
    switches.push(target);active=target;return{ok:true};
   }})
 };
 const manager={context:async()=>({newPage:async()=>page,storageState:async()=>({cookies:[],origins:[]}),close:async()=>{closed=true;}})};
 return {manager,switches,active:()=>active,closed:()=>closed};
}
test('all game IDs get distinct totals including empty cards and restore original selection',async()=>{
 const account=fakeAccount();
 const result=await fetchGameIds(account.manager,{});
 assert.deepEqual(result.gameIds.map(c=>[c.tag,c.pumbility,c.recordCount]),[['#1001',100,1],['#2002',200,1],['#3003',0,0]]);
 assert.equal(account.active(),'111');
 assert.deepEqual(account.switches,['222','333','111']);
 assert.equal(account.closed(),true);
});
test('targeted image data comes from requested card and selection restores on success and errors',async()=>{
 const account=fakeAccount();
 const result=await fetchProfile(account.manager,{}, {gameId:'BETA #2002'});
 assert.equal(result.profile.playerName,'BETA#2002');
 assert.equal(result.profile.pumbility,200);
 assert.equal(result.profile.titleProgress.playerName,'BETA#2002');
 assert.equal(result.profile.titleProgress.single.score,14200);
 assert.equal(account.active(),'111');
 const broken=fakeAccount({breakTarget:true});
 await assert.rejects(fetchProfile(broken.manager,{}, {gameId:'BETA#2002'}),{code:'PAGE_CHANGED'});
 assert.equal(broken.active(),'111');
 assert.equal(broken.closed(),true);
});
test('server selection restores when POST succeeds but following navigation fails with stale DOM',async()=>{
 const account=fakeAccount({failTargetNavigation:true});
 await assert.rejects(fetchProfile(account.manager,{}, {gameId:'BETA#2002'}),{code:'NETWORK'});
 assert.deepEqual(account.switches,['222','111']);
 assert.equal(account.active(),'111');
 assert.equal(account.closed(),true);
});
test('switching stops before mutations when initial selection is missing or inconsistent',async()=>{
 for(const options of [{invalidSelection:true},{multipleSelection:true}]){
  const account=fakeAccount(options);
  await assert.rejects(fetchGameIds(account.manager,{}),{code:'PAGE_CHANGED'});
  assert.deepEqual(account.switches,[]);
  assert.equal(account.closed(),true);
 }
});
test('bare B50 still selects first card regardless of website selection and explicit full names select other cards',async()=>{
 const account=fakeAccount({initial:'222'});
 const result=await fetchProfile(account.manager,{});
 assert.equal(result.profile.playerName,'ALPHA#1001');
 assert.equal(result.profile.pumbility,100);
 assert.equal(account.active(),'222');
 assert.deepEqual(account.switches,['111','222']);
 const explicit=fakeAccount();
 assert.equal((await fetchProfile(explicit.manager,{}, {gameId:'BETA#2002'})).profile.playerName,'BETA#2002');
});

test('login inspection lists all owned profiles without switching the selected profile',async()=>{
 const account=fakeAccount({initial:'222'}),context=await account.manager.context({});
 const data=await readAccount(await context.newPage());
 assert.equal(data.playerName,'BETA#2002');
 assert.deepEqual(data.gameIds.map(row=>row.id),['111','222','333']);
 assert.deepEqual(account.switches,[]);assert.equal(account.active(),'222');
 await context.close();
});

test('B50 restores the original profile after Title-page failures, mismatches and login redirects',async()=>{
 for(const [options,code] of [[{brokenTitle:true},'PAGE_CHANGED'],[{mismatchedTitle:true},'GAME_ID_SWITCH_FAILED'],[{redirectedTitle:true},'AUTH_REQUIRED']]){
  const account=fakeAccount(options);
  await assert.rejects(fetchProfile(account.manager,{}, {gameId:'BETA#2002'}),{code});
  assert.equal(account.active(),'111');assert.equal(account.closed(),true);
  assert.deepEqual(account.switches,['222','111']);
 }
});

test('B50 and Title identity checks agree when the official pages differ only in letter case',async()=>{
 const account=fakeAccount({lowercaseTitle:true});
 const result=await fetchProfile(account.manager,{}, {gameId:'beta#2002'});
 assert.equal(result.profile.playerName,'BETA#2002');
 assert.equal(result.profile.titleProgress.playerName,'BETA#2002');
 assert.equal(account.active(),'111');assert.equal(account.closed(),true);
});
