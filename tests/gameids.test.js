import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGameIds,resolveGameId,normalizeGameIdSelector} from '../src/parser.js';
import {fetchGameIds,fetchProfile} from '../src/client.js';
import vm from 'node:vm';

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
test('card selectors require full names and four-digit tags, rejecting old shorthand selectors',()=>{
 const cards=parseGameIds(html);
 for(const query of ['beta #2002','BETA#2002',' BETA  # 2002 '])assert.equal(resolveGameId(cards,query).id,'222');
 assert.deepEqual(cards.map(card=>card.uid),['uid1','uid2','uid3']);
 assert.equal(resolveGameId(cards,'ALPHA#1001').id,'111');
 for(const value of ['222','BETA','#2002','2002','uid0','uid2','UID2','uid9999','ALPHA#123','ALPHA#12345','A#B#1234']) {
  assert.throws(()=>resolveGameId(cards,value),{code:'GAME_ID_FORMAT'});
 }
 assert.throws(()=>resolveGameId(cards,'FOREIGN #9999'),{code:'GAME_ID_NOT_FOUND'});
 assert.equal(normalizeGameIdSelector(' SHA WN  # 1477 '),'SHA WN#1477');
 const repeatedTag=cards.map((card,index)=>index===1?{...card,tag:'#1001',playerName:'BETA#1001'}:card);
 assert.equal(resolveGameId(repeatedTag,'BETA#1001').id,'222');
 const caseVariants=[{id:'one',playerName:'Alice#1001'},{id:'two',playerName:'ALICE#1001'}];
 assert.equal(resolveGameId(caseVariants,'Alice#1001').id,'one');
 assert.throws(()=>resolveGameId(caseVariants,'aLiCe#1001'),{code:'GAME_ID_AMBIGUOUS'});
});
test('rename inputs, malformed IDs and repeated cards cannot become switch targets',()=>{
 assert.equal(parseGameIds('<form><input name="sub_profile" value="111"></form>').length,0);
 assert.equal(parseGameIds(html.replace('value="222"','value="../../admin"')).length,2);
 assert.equal(parseGameIds(html.replace('value="333"','value="222"')).length,2);
});

function fakeAccount({breakTarget=false, failTargetNavigation=false, invalidSelection=false, multipleSelection=false, initial='111'}={}) {
 let active=initial,domActive=initial,closed=false,currentUrl='about:blank';
 const switches=[];
 const cards=[{id:'111',name:'ALPHA #1001',total:100},{id:'222',name:'BETA #2002',total:200},{id:'333',name:'EMPTY #3003',total:0}];
 const page={
  url:()=>currentUrl,
  goto:async url=>{
   if(failTargetNavigation&&active==='222')throw new Error('Navigation failed after POST');
   currentUrl=url;domActive=active;return{ok:()=>true};
  },
  content:async()=>{
   const card=cards.find(c=>c.id===domActive);
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
