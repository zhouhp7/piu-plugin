import test from 'node:test';
import assert from 'node:assert/strict';
import {createRankingService} from '../src/ranking-service.js';
import {RankingStore} from '../src/ranking-store.js';
import {parseFollowBatch, resolveFollowBatch, buildRankComparison} from '../src/ranking-follow.js';
import {zoned01} from '../src/ranking-time.js';

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
  reader:{async fetch(input){calls++;if(read)await read(input);return{entries,state:input,capturedAt:current.toISOString(),audit:{count:2}};},async close(){}},
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
