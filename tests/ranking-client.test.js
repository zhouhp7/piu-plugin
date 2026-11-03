import test from 'node:test';
import assert from 'node:assert/strict';
import {RankingReader, RANKING_URL, rankingSessionState} from '../src/ranking-client.js';

function html(from, count, next) {
 return `<ul class="pumbilitySt">${Array.from({length:count},(_,index)=>{
  const rank=from+index;
  return `<li style="display:none"><div class="num"><i class="tt">${rank}</i></div><div class="profile_name pl0">P${rank}</div><div class="profile_name st1">#${String(rank%10000).padStart(4,'0')}</div><div class="score"><i class="tt">${20000-rank}.50</i></div></li>`;
 }).join('')}</ul>${next?`<div class="board_paging"><a rel="next" href="?page=${next}">next</a></div>`:''}`;
}
function fixture(pages,{login=false}={}) {
 let url='about:blank',active=0,closed=false;
 const page={
  async goto(target){url=login?'https://www.piugame.com/login.php':target;active=Number(new URL(target).searchParams.get('page')??1);return{ok:()=>true};},
  url:()=>url,async content(){return pages[active];},
 };
 const browser={async context(){return{async route(){},async newPage(){return page;},async storageState(){return{cookies:[],origins:[]};},async close(){closed=true;}};},async close(){}};
 return{reader:new RankingReader({}, {browser}),closed:()=>closed};
}
test('ranking reader includes hidden source rows and returns exactly1000 with audit',async()=>{
 const f=fixture({1:html(1,1000)});
 const data=await f.reader.fetch({});
 assert.equal(data.entries.length,1000);assert.equal(data.entries.at(-1).worldRank,1000);
 assert.equal(data.audit.count,1000);assert.ok(data.capturedAt);assert.equal(f.closed(),true);
});
test('incomplete pages, repeated cross-page identities, and login redirects never produce a snapshot',async()=>{
 const incomplete=fixture({1:html(1,999)});
 await assert.rejects(incomplete.reader.fetch({}),{code:'RANK_INCOMPLETE'});assert.equal(incomplete.closed(),true);
 const repeated=fixture({1:html(1,600,2),2:html(590,411)});
 await assert.rejects(repeated.reader.fetch({}),{code:'RANK_INCOMPLETE'});assert.equal(repeated.closed(),true);
 const expired=fixture({}, {login:true});
 await assert.rejects(expired.reader.fetch({}),{code:'RANK_AUTH'});assert.equal(expired.closed(),true);
});
test('ranking session persistence is restricted to explicitly allowed PIU/AM-PASS domains',()=>{
 const data=rankingSessionState({cookies:[{domain:'.piugame.com'},{domain:'api.am-pass.net'},{domain:'piugame.com.evil.test'}],
  origins:[{origin:'https://www.piugame.com'},{origin:'https://api.am-pass.net'},{origin:'http://www.piugame.com'}]});
 assert.equal(data.cookies.length,2);assert.equal(data.origins.length,2);
 assert.match(RANKING_URL,/^https:\/\/www\.piugame\.com\/leaderboard\//);
});
