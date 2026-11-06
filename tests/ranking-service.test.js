import test from 'node:test';
import assert from 'node:assert/strict';
import {createRankingService} from '../src/ranking-service.js';
import {RankingStore} from '../src/ranking-store.js';
import {parseFollowBatch, parseFullPlayer, canonicalPlayer, resolveFollowBatch, buildRankComparison} from '../src/ranking-follow.js';
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
function fixture(t,{time='2026-11-03T00:30:00+08:00',read,save,login=true,config={}}={}) {
 let current=new Date(time),calls=0,saves=0;
 const store=new RankingStore({filename:':memory:',minEntries:2});
 const saved=new Map(login?[['leaderboard-reader',{state,savedAt:current.toISOString()}]]:[]);
 const clock=timers(),warnings=[];
 const service=createRankingService({dataDir:'/unused',rankEnabled:true,rankKeepAliveMs:0,captureRetries:0,...config},{
  store,vault:{async load(key){return saved.get(key)??null;},async save(key,value){saves++;await save?.(key,value);saved.set(key,value);}},
  reader:{async fetch(input){calls++;const extra=read?await read(input):{};return{entries,state:input,capturedAt:current.toISOString(),audit:{count:2},...extra};},async close(){}},
  now:()=>new Date(current),timers:clock,logger:{warn:message=>warnings.push(message)},
  render:async input=>Buffer.from(JSON.stringify(input)),
 });
 t.after(()=>service.close());
 return{service,store,clock,warnings,saved,calls:()=>calls,saves:()=>saves,setTime:value=>{current=new Date(value);}};
}
function snapshot(store,date,rows=entries){store.saveSnapshot({date,kind:'scheduled',capturedAt:zoned01(date),scheduledAt:zoned01(date),entries:rows});}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function activeTimer(f){
 const active=f.clock.rows.filter(row=>row.type==='timeout'&&!row.cleared&&!row.fired);
 assert.equal(active.length,1,'only one capture timer should be active');
 return active[0];
}
async function fireTimer(f,time){
 const timer=activeTimer(f);timer.fired=true;f.setTime(time);await timer.fn();
}

test('explicit follow identities reject pure tags/names/uid and preserve duplicate-tag players',()=>{
 for(const text of ['#1111','ALPHA','uid1'])assert.throws(()=>parseFollowBatch(text),{code:'RANK_ID'});
 const selectors=parseFollowBatch('ALPHA#1111 BETA#1111');
 assert.equal(resolveFollowBatch(entries,selectors).length,2);
 assert.deepEqual(parseFollowBatch('alpha#1111 beta #1111'),[{gameId:'ALPHA',tag:'#1111'},{gameId:'BETA',tag:'#1111'}]);
 assert.throws(()=>parseFollowBatch('"NAME WITH SPACE#1234"'),{code:'RANK_ID'});
 assert.throws(()=>parseFollowBatch('"ALPHA#1111'),{code:'RANK_ID'});
});
test('batch follow/unfollow is atomic, idempotent for known follows, and owner isolated',async t=>{
 const f=fixture(t,{login:false});
 await assert.rejects(f.service.follow('owner','ALPHA#1111 INVALID_NAME#1111'),{code:'RANK_ID'});
 assert.deepEqual(f.service.listFollows('owner'),[]);
 assert.equal((await f.service.follow('owner','ALPHA#1111 BETA#1111')).added.length,2);
 assert.equal((await f.service.follow('owner','ALPHA#1111')).added.length,0);
 assert.equal(f.service.listFollows('other').length,0);
 assert.equal(f.service.unfollow('owner','BETA#1111').removed.length,1);
 assert.equal(f.service.listFollows('owner')[0].gameId,'ALPHA');
});
test('valid full IDs can be followed without snapshots, login or website requests',async t=>{
 const f=fixture(t,{login:false,read:async()=>{throw new Error('follow must stay local');}});
 const result=await f.service.follow('group:123','missing#1111 MISSING#1111 other#1111');
 assert.deepEqual(result.added.map(row=>row.playerKey),['game:MISSING#1111','game:OTHER#1111']);
 assert.deepEqual(result.follows.map(row=>row.gameId),['MISSING','OTHER']);
 assert.equal((await f.service.follow('group:123','Missing#1111')).added.length,0);
 assert.equal(f.calls(),0);assert.equal(f.saved.size,0);assert.deepEqual(f.store.listSnapshots(),[]);
 assert.equal(f.service.unfollow('group:123','missing#1111').removed.length,1);
 assert.throws(()=>f.service.unfollow('group:123','missing#1111'),error=>error.code==='RANK_NOT_FOUND'&&!error.message.includes('1000'));
});
test('follows absent from saved rankings are retained and match future captured entries',async t=>{
 const f=fixture(t);await f.service.capture();
 const result=await f.service.follow('owner','MISSING#1111');
 assert.equal(result.added.length,1);assert.equal(f.calls(),1);
 const preview=JSON.parse((await f.service.preview('owner')).toString());
 assert.equal(preview.rows[0].gameId,'MISSING');assert.equal(preview.rows[0].current,null);
 snapshot(f.store,'20261026');
 snapshot(f.store,'20261102',[...entries,{playerKey:'game:MISSING#1111',gameId:'MISSING',tag:'#1111',worldRank:3,score:80}]);
 const comparison=JSON.parse((await f.service.rank('owner')).toString());
 assert.equal(comparison.rows[0].current.worldRank,3);assert.equal(comparison.rows[0].previous,null);
});
test('arbitrary follows still enforce the list limit atomically after deduplication',async t=>{
 const f=fixture(t,{login:false});
 const ids=Array.from({length:100},(_,i)=>`PLAYER${i}#0001`);
 await f.service.follow('owner',ids.join(' '));
 assert.equal((await f.service.follow('owner','player0#0001 PLAYER0#0001')).added.length,0);
 await assert.rejects(f.service.follow('owner','EXTRA#0001'),{code:'RANK_FOLLOW_LIMIT'});
 assert.equal(f.service.listFollows('owner').length,100);assert.equal(f.calls(),0);
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
test('daily failures retry every 30 minutes until success, then resume the next daily slot',async t=>{
 let failures=2;
 const f=fixture(t,{read:async()=>{if(failures-->0)throw new PiuError('RANK_NETWORK','offline');}});
 f.service.start();await settle();
 await fireTimer(f,'2026-11-03T01:00:00+08:00');
 assert.equal(activeTimer(f).delay,30*60_000);assert.equal(activeTimer(f).unreferenced,true);
 assert.equal(f.service.status().nextCaptureAt,'2026-11-02T17:30:00.000Z');
 await fireTimer(f,'2026-11-03T01:30:00+08:00');
 assert.equal(activeTimer(f).delay,30*60_000);assert.equal(f.calls(),2);
 assert.equal(f.store.getSnapshot('20261103'),null);
 await fireTimer(f,'2026-11-03T02:00:00+08:00');
 const saved=f.store.getSnapshot('20261103');
 assert.equal(saved.kind,'catchup');assert.equal(saved.capturedAt,'2026-11-02T18:00:00.000Z');
 assert.equal(saved.scheduledAt,zoned01('20261103'));assert.equal(f.calls(),3);
 assert.equal(f.service.status().nextCaptureAt,zoned01('20261104'));
 assert.equal(activeTimer(f).delay,23*60*60_000);
 await fireTimer(f,'2026-11-04T01:00:00+08:00');
 assert.equal(f.store.getSnapshot('20261104').kind,'scheduled');assert.equal(f.calls(),4);
});
test('database and session save failures both trigger the 30-minute catchup',async t=>{
 for(const failure of ['database','session']){
  let failSave=failure==='session';
  const f=fixture(t,{save:async()=>{if(failSave)throw new Error('write failed');}});
  const before=structuredClone(f.saved.get('leaderboard-reader'));
  f.service.start();await settle();
  if(failure==='database')f.store.db.exec('PRAGMA query_only = ON');
  await fireTimer(f,'2026-11-03T01:00:00+08:00');
  assert.equal(activeTimer(f).delay,30*60_000);
  assert.equal(f.store.getSnapshot('20261103'),null);
  assert.deepEqual(f.saved.get('leaderboard-reader'),before);
  f.store.db.exec('PRAGMA query_only = OFF');failSave=false;
  await fireTimer(f,'2026-11-03T01:30:00+08:00');
  assert.equal(f.store.getSnapshot('20261103').kind,'catchup');
  assert.equal(f.service.status().nextCaptureAt,zoned01('20261104'));
 }
});
test('failed startup catchup retries, including after ranking authorization becomes available',async t=>{
 const f=fixture(t,{time:'2026-11-03T02:00:00+08:00',login:false});
 f.service.start({keepAlive:true});await settle();
 assert.equal(f.calls(),0);assert.equal(activeTimer(f).delay,30*60_000);
 assert.equal(activeTimer(f).unreferenced,undefined);
 const timer=activeTimer(f);f.service.start();assert.equal(activeTimer(f),timer);
 f.saved.set('leaderboard-reader',{state,savedAt:'2026-11-02T18:05:00.000Z'});
 await fireTimer(f,'2026-11-03T02:30:00+08:00');
 assert.equal(f.store.getSnapshot('20261103').kind,'catchup');assert.equal(f.calls(),1);
 assert.equal(f.service.status().nextCaptureAt,zoned01('20261104'));
});
test('late failures end at the GMT+8 day boundary and next year starts with its own daily capture',async t=>{
 let fail=true;
 const f=fixture(t,{time:'2026-12-31T23:45:00+08:00',read:async()=>{if(fail)throw new Error('offline');}});
 f.service.start();await settle();
 assert.equal(activeTimer(f).delay,75*60_000);
 assert.equal(f.service.status().nextCaptureAt,zoned01('20270101'));
 fail=false;await fireTimer(f,'2027-01-01T01:00:00+08:00');
 assert.equal(f.store.getSnapshot('20261231'),null);
 assert.equal(f.store.getSnapshot('20270101').kind,'scheduled');
});
test('a capture crossing midnight schedules the new daily slot without backdating or a midnight retry',async t=>{
 const f=fixture(t,{time:'2026-11-03T23:30:00+08:00',read:async()=>{f.setTime('2026-11-04T00:05:00+08:00');}});
 f.service.start();await settle();
 assert.equal(f.store.listSnapshots().length,0);
 assert.equal(f.service.status().nextCaptureAt,zoned01('20261104'));
 assert.equal(activeTimer(f).delay,55*60_000);
});
test('a successful catchup from another request prevents the pending retry from fetching again',async t=>{
 let fail=true;
 const f=fixture(t,{read:async()=>{if(fail)throw new Error('offline');}});
 f.service.start();await settle();await fireTimer(f,'2026-11-03T01:00:00+08:00');
 fail=false;f.setTime('2026-11-03T01:10:00+08:00');await f.service.runDue();
 assert.equal(f.calls(),2);
 await fireTimer(f,'2026-11-03T01:30:00+08:00');
 assert.equal(f.calls(),2);assert.equal(f.store.listSnapshots().length,1);
 assert.equal(f.service.status().nextCaptureAt,zoned01('20261104'));
});
test('closing cancels a pending retry and disabled scheduling never creates one',async t=>{
 const f=fixture(t,{time:'2026-11-03T02:00:00+08:00',read:async()=>{throw new Error('offline');}});
 f.service.start();await settle();const retry=activeTimer(f);
 assert.equal(retry.delay,30*60_000);await f.service.close();assert.equal(retry.cleared,true);
 const disabled=fixture(t,{config:{rankEnabled:false}});disabled.service.start();await settle();
 assert.equal(disabled.clock.rows.length,0);assert.equal(disabled.calls(),0);
});
test('closing during a failed capture does not rearm its retry timer',async t=>{
 let release,started;
 const waiting=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
 const f=fixture(t,{time:'2026-11-03T02:00:00+08:00',read:async()=>{started();await waiting;throw new Error('offline');}});
 f.service.start();await ready;const closing=f.service.close();release();await closing;await settle();
 assert.ok(f.clock.rows.every(row=>row.cleared));
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

test('snapshot write failures preserve ranking authorization and allow a later import retry',async t=>{
 const f=fixture(t);await f.service.capture();
 const before=structuredClone(f.saved.get('leaderboard-reader')),snapshots=f.store.listSnapshots(),saves=f.saves();
 f.setTime('2026-11-03T00:31:00+08:00');
 f.store.db.exec('PRAGMA query_only = ON');
 await assert.rejects(f.service.importCookies('sid=replacement'),{code:'RANK_COOKIE_IMPORT_FAILED'});
 assert.deepEqual(f.saved.get('leaderboard-reader'),before);
 assert.deepEqual(f.store.listSnapshots(),snapshots);assert.equal(f.saves(),saves);
 f.store.db.exec('PRAGMA query_only = OFF');
 await f.service.importCookies('sid=replacement');
 assert.equal(f.saved.get('leaderboard-reader').state.cookies[0].value,'replacement');
 assert.equal(f.store.listSnapshots().length,2);
});

test('snapshot validation failures never replace ranking authorization',async t=>{
 let invalid=false;
 const f=fixture(t,{read:async()=>invalid?{entries:[]}:undefined});await f.service.capture();
 const before=structuredClone(f.saved.get('leaderboard-reader')),snapshots=f.store.listSnapshots(),saves=f.saves();invalid=true;
 await assert.rejects(f.service.importCookies('sid=replacement'),{code:'RANK_SNAPSHOT'});
 assert.deepEqual(f.saved.get('leaderboard-reader'),before);
 assert.deepEqual(f.store.listSnapshots(),snapshots);assert.equal(f.saves(),saves);
});

test('session save failures roll back only new snapshots and preserve idempotent history',async t=>{
 let rejectSave=false;
 const f=fixture(t,{save:async()=>{if(rejectSave)throw new Error('sid=secret-never-echo');}});
 await f.service.capture();
 const before=structuredClone(f.saved.get('leaderboard-reader')),snapshots=f.store.listSnapshots(),original=f.store.getSnapshot('20261103');
 rejectSave=true;
 for(const time of ['2026-11-03T00:31:00+08:00','2026-11-03T00:30:00+08:00']){
  f.setTime(time);
  await assert.rejects(f.service.importCookies('sid=replacement'),error=>error.code==='RANK_COOKIE_IMPORT_FAILED'&&!error.message.includes('secret-never-echo'));
  assert.deepEqual(f.saved.get('leaderboard-reader'),before);
  assert.deepEqual(f.store.listSnapshots(),snapshots);
  assert.deepEqual(f.store.getSnapshot('20261103'),original);
 }
});

test('an initial authorization save failure leaves no session or snapshot',async t=>{
 const f=fixture(t,{login:false,save:async()=>{throw new Error('write failed');}});
 await assert.rejects(f.service.importCookies('sid=replacement'),{code:'RANK_COOKIE_IMPORT_FAILED'});
 assert.equal(f.saved.size,0);assert.deepEqual(f.store.listSnapshots(),[]);
});

test('follow writes remain available during a pending session save and survive snapshot rollback',async t=>{
 let reject;
 const waiting=new Promise((_resolve,fail)=>{reject=fail;});let started;
 const ready=new Promise(resolve=>{started=resolve;});
 const f=fixture(t,{save:async()=>{started();await waiting;}});
 const importing=f.service.importCookies('sid=replacement');
 const failed=assert.rejects(importing,{code:'RANK_COOKIE_IMPORT_FAILED'});
 await ready;
 await f.service.follow('owner','ALPHA#1111 BETA#1111');
 f.service.unfollow('owner','BETA#1111');
 reject(new Error('write failed'));await failed;
 assert.deepEqual(f.store.listSnapshots(),[]);
 assert.deepEqual(f.service.listFollows('owner').map(row=>row.gameId),['ALPHA']);
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

test('follow names share strict ASCII naming and case-insensitive complete identity matching',()=>{
 assert.deepEqual(parseFullPlayer('aBc123#0101'),{gameId:'ABC123',tag:'#0101'});
 assert.equal(canonicalPlayer({gameId:'alpha',tag:'#1111'}),'ALPHA#1111');
 assert.equal(resolveFollowBatch(entries,parseFollowBatch('alpha#1111 ALPHA#1111')).length,1);
 for(const input of ['NAME WITH SPACE#1111','A_B#1111','A-B#1111','名字#1111','A'.repeat(13)+'#1111','é#1111']){
  assert.throws(()=>parseFullPlayer(input),{code:'RANK_ID'});
 }
 const duplicate=[entries[0],{...entries[0],gameId:'alpha',playerKey:'game:alpha#1111'}];
 assert.throws(()=>resolveFollowBatch(duplicate,parseFollowBatch('ALPHA#1111')),{code:'RANK_ID'});
});
