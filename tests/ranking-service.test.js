import test from 'node:test';
import assert from 'node:assert/strict';
import {createRankingService} from '../src/ranking-service.js';
import {RankingStore} from '../src/ranking-store.js';
import {parseFollowBatch, resolveFollowBatch, buildRankComparison} from '../src/ranking-follow.js';
import {zoned01} from '../src/ranking-time.js';
import {PiuError} from '../src/errors.js';

const state = {cookies:[{domain:'.piugame.com',name:'sid',value:'test-only'}],origins:[]};
const entries = [
 {playerKey:'game:ALPHA#1111',gameId:'ALPHA',tag:'#1111',worldRank:1,score:100,country:null,lastPlayedAt:null},
 {playerKey:'game:BETA#1111',gameId:'BETA',tag:'#1111',worldRank:2,score:90,country:null,lastPlayedAt:null},
];
function timers() {
 const rows=[];
 const make=(type,fn,delay)=>{const handle={type,fn,delay,unref(){this.unreferenced=true;}};rows.push(handle);return handle;};
 return {rows,setTimeout:(fn,delay)=>make('timeout',fn,delay),setInterval:(fn,delay)=>make('interval',fn,delay),
  clearTimeout:handle=>{if(handle)handle.cleared=true;},clearInterval:handle=>{if(handle)handle.cleared=true;}};
}
function fixture(t,{time='2026-11-03T00:30:00+08:00',read,login=true}={}) {
 let current=new Date(time),calls=0;
 const store=new RankingStore({filename:':memory:',minEntries:2});
 const saved=new Map(login?[['leaderboard-reader',{state,savedAt:current.toISOString()}]]:[]);
 const clock=timers(),warnings=[];
 const service=createRankingService({dataDir:'/unused',rankEnabled:true,rankKeepAliveMs:0,captureRetries:0},{
  store,vault:{async load(key){return saved.get(key)??null;},async save(key,value){saved.set(key,value);}},
  reader:{async fetch(input){calls++;const extra=read?await read(input):{};return{entries,state:input,capturedAt:current.toISOString(),audit:{count:2},...extra};},async close(){}},
  now:()=>new Date(current),timers:clock,logger:{warn:message=>warnings.push(message)},
  render:async input=>Buffer.from(JSON.stringify(input)),
 });
 t.after(()=>service.close());
 return{service,store,clock,warnings,saved,calls:()=>calls,setTime:value=>{current=new Date(value);}};
}
function snapshot(store,date,rows=entries){store.saveSnapshot({date,kind:'scheduled',capturedAt:zoned01(date),scheduledAt:zoned01(date),entries:rows});}

test('explicit follow identities reject pure tags/names/uid and preserve duplicate-tag players',()=>{
 for(const text of ['#1111','ALPHA','uid1'])assert.throws(()=>parseFollowBatch(text),{code:'RANK_ID'});
 const selectors=parseFollowBatch('ALPHA#1111 BETA#1111');
 assert.equal(resolveFollowBatch(entries,selectors).length,2);
 assert.deepEqual(parseFollowBatch('"NAME WITH SPACE#1234" ALPHA #1111'),[{gameId:'NAME WITH SPACE',tag:'#1234'},{gameId:'ALPHA',tag:'#1111'}]);
 assert.throws(()=>parseFollowBatch('"ALPHA#1111'),{code:'RANK_ID'});
});
test('batch follow/unfollow is atomic, idempotent for known follows, and owner isolated',async t=>{
 const f=fixture(t);await f.service.capture();
 await assert.rejects(f.service.follow('owner','ALPHA#1111 MISSING#1111'),{code:'RANK_NOT_FOUND'});
 assert.deepEqual(f.service.listFollows('owner'),[]);
 assert.equal((await f.service.follow('owner','ALPHA#1111 BETA#1111')).added.length,2);
 assert.equal((await f.service.follow('owner','ALPHA#1111')).added.length,0);
 assert.equal(f.service.listFollows('other').length,0);
 assert.equal(f.service.unfollow('owner','BETA#1111').removed.length,1);
 assert.equal(f.service.listFollows('owner')[0].gameId,'ALPHA');
});
test('rank uses exact default Mondays; missing history never falls back to current data',async t=>{
 const f=fixture(t);await f.service.capture();await f.service.follow('owner','ALPHA#1111');
 await assert.rejects(f.service.rank('owner'),error=>error.code==='RANK_MISSING'&&error.message.includes('20261102')&&error.message.includes('20261026'));
 snapshot(f.store,'20261102');snapshot(f.store,'20261026',entries.map(row=>({...row,score:row.score-1})));
 const image=JSON.parse((await f.service.rank('owner')).toString());
 assert.equal(image.current.date,'20261102');assert.equal(image.previous.date,'20261026');
 assert.equal(image.rankBasis,'followed');assert.equal(image.rows[0].current.followRank,1);
 const reversed=JSON.parse((await f.service.rank('owner','20261026','20261102')).toString());
 assert.equal(reversed.current.date,'20261026');
});
test('capture records real current time; past and future-01 captures cannot be fabricated',async t=>{
 const f=fixture(t);
 const meta=await f.service.capture();assert.equal(meta.kind,'manual');assert.equal(meta.scheduledAt,null);
 assert.equal(meta.date,'20261103');assert.equal(f.store.getSnapshot('20261103').entries.length,2);
 await assert.rejects(f.service.capture({date:'20261102'}),{code:'RANK_DATE'});
 await assert.rejects(f.service.capture({kind:'scheduled'}),{code:'RANK_DATE'});
});
test('scheduler targets next GMT+8 01:00 independent of host timezone, and catches up only today',async t=>{
 const f=fixture(t);f.service.start();
 assert.equal(f.clock.rows[0].delay,30*60_000);assert.equal(f.clock.rows[0].unreferenced,true);
 await f.service.runDue();assert.equal(f.calls(),0);
 f.setTime('2026-11-03T02:00:00+08:00');
 await f.service.runDue();assert.equal(f.store.getSnapshot('20261103').kind,'catchup');
 assert.equal(f.store.getSnapshot('20261103').capturedAt,'2026-11-02T18:00:00.000Z');
 await f.service.runDue();assert.equal(f.calls(),1);
 assert.equal(f.store.getSnapshot('20261102'),null);
});
test('keepalive refreshes authorized state without creating ranking snapshots',async t=>{
 const f=fixture(t);await f.service.keepAlive();assert.equal(f.calls(),1);assert.equal(f.store.listSnapshots().length,0);
 const noLogin=fixture(t,{login:false});await assert.rejects(noLogin.service.capture(),{code:'RANK_AUTH'});
 assert.equal(noLogin.store.listSnapshots().length,0);
});
test('setSession verifies a dedicated ranking session and creates an explicitly manual snapshot',async t=>{
 const f=fixture(t,{login:false});await f.service.setSession(state);
 assert.ok(f.saved.has('leaderboard-reader'));assert.equal(f.store.getSnapshot('20261103').kind,'manual');
 assert.equal(f.calls(),1);
});
test('comparison keeps absent players missing and uses followed-player ranks rather than nationality',()=>{
 const follows=entries;
 const current={entries:[entries[1]]};const previous={entries:[entries[0]]};
 const data=buildRankComparison(current,previous,follows);
 assert.equal(data.rankBasis,'followed');assert.equal(data.rows[0].current,null);
 assert.equal(data.rows[1].previous,null);assert.equal(data.rows[1].current.followRank,1);
});

test('ranking Cookie import validates and saves a dedicated refreshed session and manual snapshot',async t=>{
 const refreshed={cookies:[{domain:'.piugame.com',name:'sid',value:'refreshed'}],origins:[]};
 const f=fixture(t,{login:false,read:async input=>{
  assert.equal(input.cookies.length,1);assert.equal(input.cookies[0].value,'submitted');
  assert.deepEqual(input.origins,[]);assert.equal(f.saved.has('leaderboard-reader'),false);
  return{state:refreshed};
 }});
 const meta=await f.service.importCookies(JSON.stringify({cookies:[
  {domain:'.piugame.com',name:'sid',value:'submitted'},
  {domain:'api.am-pass.net',name:'sso',value:'excluded'},
 ],origins:[{origin:'https://www.piugame.com',localStorage:[{name:'ignored',value:'x'}]}]}));
 assert.equal(meta.count,2);assert.equal(meta.kind,'manual');assert.equal(f.calls(),1);
 assert.equal(f.saved.get('leaderboard-reader').state.cookies[0].value,'refreshed');
});

test('rejected ranking Cookie imports preserve the previous binding and snapshot and redact errors',async t=>{
 for(const error of [new PiuError('RANK_AUTH','expired'),new PiuError('RANK_INCOMPLETE','incomplete'),new Error('sid=secret-never-echo')]){
  let fail=false;
  const f=fixture(t,{read:async()=>{if(fail)throw error;}});
  await f.service.capture();
  const before=structuredClone(f.saved.get('leaderboard-reader')),snapshot=f.store.getSnapshot('20261103');fail=true;
  await assert.rejects(f.service.importCookies('sid=secret-never-echo'),failure=>{
   assert.ok(!failure.message.includes('secret-never-echo'));
   return ['RANK_AUTH','RANK_INCOMPLETE','RANK_COOKIE_IMPORT_FAILED'].includes(failure.code);
  });
  assert.deepEqual(f.saved.get('leaderboard-reader'),before);
  assert.deepEqual(f.store.getSnapshot('20261103'),snapshot);
  const calls=f.calls();
  await assert.rejects(f.service.importCookies('malformed'),{code:'COOKIE_FORMAT'});
  assert.equal(f.calls(),calls);
 }
});

test('ranking Cookie import queues behind capture and keepalive uses the new session',async t=>{
 let release,started;
 const ready=new Promise(resolve=>{started=resolve;}),wait=new Promise(resolve=>{release=resolve;});
 const seen=[];
 const f=fixture(t,{read:async input=>{
  seen.push(input.cookies[0].value);if(seen.length===1){started();await wait;}
 }});
 const capture=f.service.capture();await ready;
 const importing=f.service.importCookies('sid=updated');assert.equal(f.calls(),1);release();
 await Promise.all([capture,importing]);await f.service.keepAlive();
 assert.deepEqual(seen,['test-only','updated','updated']);
});

test('ranking Cookie import requires an encryption key before accessing the website',async t=>{
 let called=false;
 const service=createRankingService({dataDir:'/unused'}, {
  store:new RankingStore({filename:':memory:',minEntries:2}),
  reader:{async fetch(){called=true;},async close(){}},
 });
 t.after(()=>service.close());
 await assert.rejects(service.importCookies('sid=test-only'),error=>error.code==='RANK_AUTH'&&error.message.includes('PIU_SESSION_KEY'));
 assert.equal(called,false);
});
