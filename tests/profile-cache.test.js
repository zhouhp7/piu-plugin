import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createService} from '../src/service.js';
import {Vault} from '../src/vault.js';
import {PiuError} from '../src/errors.js';

const profile=(id,name,tag)=>({id,gameId:name,tag:`#${tag}`,playerName:`${name}#${tag}`,pumbility:100,recordCount:1});
const first=[profile('11','SHARED','1111'),profile('12','ZANTING','9403'),profile('13','OTHER','2222')];
const second=[profile('21','SHARED','3333'),profile('22','BETA','1111')];
const state=value=>({cookies:[{name:'sid',value,domain:'.piugame.com',path:'/'}],origins:[]});
const gate=()=>{
  let start,release;
  return {ready:new Promise(resolve=>{start=resolve;}),waiting:new Promise(resolve=>{release=resolve;}),start:()=>start(),release:()=>release()};
};

async function fixture(t,options={}) {
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'piu-profile-cache-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const vault=new Vault({directory:path.join(dataDir,'sessions'),key:Buffer.alloc(32,8)});
  await vault.save('owner',options.initial??{version:2,accounts:[
    {id:'a',state:state('session-a'),savedAt:Date.now(),profilesUpdatedAt:0,gameIds:first},
    {id:'b',state:state('session-b'),savedAt:Date.now(),profilesUpdatedAt:0,gameIds:second},
  ]});
  const calls={ids:[],images:[]};let callbacks;
  const imageFetch=kind=>async(_browser,saved,{gameId})=>{
    const account=saved.cookies[0].value;
    calls.images.push({kind,account,gameId});
    const extra=options.onImage?await options.onImage(kind,account,gameId):{};
    return {profile:{playerName:gameId,label:`${kind}:${account}:${gameId}`},images:new Map(),state:saved,...extra};
  };
  const start=async()=>{
    const service=await createService({dataDir,cacheMs:120000,maxFetches:3,sessionMaxAgeMs:86400000},{
      vault,browser:{async close(){}},
      createBridge:async config=>{callbacks=config;return{async revoke(){},async createTicket(){return{url:'http://localhost/login',expiresAt:Date.now()+300000};},async close(){}};},
      fetchGameIds:async(_browser,saved)=>{
        const account=saved.cookies[0].value;calls.ids.push(account);
        const rows=options.onIds?await options.onIds(account):account==='session-a'?first:second;
        return {gameIds:structuredClone(rows),state:saved};
      },
      fetchProfile:imageFetch('b50'),fetchRecent:imageFetch('recent'),fetchPlayData:imageFetch('data'),
      renderBest50:async value=>Buffer.from(value.label),renderRecent:async value=>Buffer.from(value.label),renderPlayData:async value=>Buffer.from(value.label),
    });
    t.after(()=>service.close());return service;
  };
  const service=await start();
  return {service,vault,calls,start,callbacks:()=>callbacks};
}

test('list reads persistent cached profiles with stable numbering and never refreshes by age or restart',async t=>{
  const f=await fixture(t);
  const rows=await f.service.gameIds('owner');
  assert.deepEqual(rows.map(row=>row.index),[1,2,3,4,5]);
  assert.equal(rows[0].isDefault,true);assert.equal(rows[1].isDefault,false);
  assert.equal(rows[0].cachedAt,0);
  rows[0].playerName='tampered';
  assert.equal((await f.service.gameIds('owner'))[0].playerName,'SHARED#1111');
  await f.service.close();
  const restarted=await f.start();
  assert.equal((await restarted.gameIds('owner')).length,5);
  assert.deepEqual(f.calls.ids,[]);
});

test('index, unique name, unique tag and full ID share a canonical image cache across all card types',async t=>{
  const f=await fixture(t);
  for(const method of ['best50','recent','data']) {
    const image=await f.service[method]('owner','2');
    for(const input of ['ZANTING','#9403','ZANTING#9403','zanting']) assert.strictEqual(await f.service[method]('owner',input),image);
  }
  assert.equal(f.calls.images.length,3);
  assert.ok(f.calls.images.every(row=>row.account==='session-a'&&row.gameId==='ZANTING#9403'));
  assert.deepEqual(f.calls.ids,[]);
});

test('duplicate names and duplicate tags fail locally without guessing or requesting the official website',async t=>{
  const f=await fixture(t);
  for(const input of ['SHARED','shared','#1111']) await assert.rejects(f.service.best50('owner',input),{code:'GAME_ID_AMBIGUOUS'});
  for(const input of ['MISSING','999']) await assert.rejects(f.service.best50('owner',input),{code:'GAME_ID_NOT_FOUND'});
  assert.deepEqual(f.calls.ids,[]);assert.deepEqual(f.calls.images,[]);
  assert.match((await f.service.best50('owner','4')).toString(),/session-b:SHARED#3333$/);
});

test('default profile is encrypted, user scoped, shared by all card types and survives image reads and service restart',async t=>{
  const f=await fixture(t);
  const selected=await f.service.setDefault('owner','4');
  assert.equal(selected.playerName,'SHARED#3333');assert.equal(selected.isDefault,true);
  const row=(await f.service.gameIds('owner')).find(item=>item.isDefault);
  assert.equal(row.index,4);
  await f.service.best50('owner');await f.service.recent('owner');await f.service.data('owner');
  assert.ok(f.calls.images.every(item=>item.account==='session-b'&&item.gameId==='SHARED#3333'));
  await f.service.close();const restarted=await f.start();
  assert.equal((await restarted.gameIds('owner')).find(item=>item.isDefault).index,4);
  assert.match((await restarted.best50('owner')).toString(),/session-b:SHARED#3333$/);
  assert.deepEqual((await f.vault.load('owner')).defaultProfile,{accountId:'b',profileId:'21'});
  assert.ok(!(await readFile(f.vault.file(f.vault.identity('owner')),'utf8')).includes('session-b'));
  await assert.rejects(restarted.setDefault('other','4'),{code:'AUTH_REQUIRED'});
  await assert.rejects(restarted.best50('other','4'),{code:'AUTH_REQUIRED'});
  assert.deepEqual(f.calls.ids,[]);
});

test('changing default cannot return another profile image from the old implicit cache key',async t=>{
  const f=await fixture(t);
  const before=await f.service.best50('owner');
  await f.service.setDefault('owner','4');
  const after=await f.service.best50('owner');
  assert.notStrictEqual(before,after);assert.match(after.toString(),/session-b:SHARED#3333$/);
  await f.service.setDefault('owner','1');
  assert.strictEqual(await f.service.best50('owner'),before);
});

test('only refresh changes profile membership and order; selected default follows stable official ID after rename',async t=>{
  const renamed=profile('12','RENAMED','9403');
  const f=await fixture(t,{onIds:async account=>account==='session-a'?[renamed,first[0]]:second});
  await f.service.setDefault('owner','2');
  const old=await f.service.best50('owner');
  assert.equal((await f.service.gameIds('owner'))[1].playerName,'ZANTING#9403');
  assert.deepEqual(f.calls.ids,[]);
  const rows=await f.service.refresh('owner');
  assert.equal(rows.length,4);assert.equal(rows[0].playerName,'RENAMED#9403');assert.equal(rows[0].isDefault,true);
  assert.deepEqual(f.calls.ids,['session-a','session-b']);
  const updated=await f.service.best50('owner');
  assert.notStrictEqual(updated,old);assert.match(updated.toString(),/RENAMED#9403$/);
  await assert.rejects(f.service.best50('owner','ZANTING'),{code:'GAME_ID_NOT_FOUND'});
  assert.deepEqual(f.calls.ids,['session-a','session-b']);
});

test('ordinary score reads do not overwrite profile metadata discovered on the website',async t=>{
  const f=await fixture(t,{onImage:async()=>({gameIds:[profile('99','UNREQUESTED','9999')]})});
  await f.service.best50('owner','2');
  assert.equal((await f.service.gameIds('owner')).length,5);
  await assert.rejects(f.service.best50('owner','UNREQUESTED'),{code:'GAME_ID_NOT_FOUND'});
  assert.deepEqual(f.calls.ids,[]);
});

test('refresh failures preserve old disk cache, default and image cache',async t=>{
  const f=await fixture(t,{onIds:async account=>{
    if(account==='session-b')throw new PiuError('NETWORK','test network failure');
    return [profile('99','NEW','9999')];
  }});
  await f.service.setDefault('owner','4');const old=await f.service.best50('owner');
  const before=await f.vault.load('owner');
  await assert.rejects(f.service.refresh('owner'),{code:'NETWORK'});
  assert.deepEqual(await f.vault.load('owner'),before);
  assert.strictEqual(await f.service.best50('owner'),old);
});

test('refresh merges concurrent requests and default changes respect in-flight network work',async t=>{
  const blocked=gate();
  const f=await fixture(t,{onIds:async account=>{
    if(account==='session-a'){blocked.start();await blocked.waiting;}return account==='session-a'?first:second;
  }});
  const refresh=f.service.refresh('owner');await blocked.ready;
  const duplicate=f.service.refresh('owner'),listing=f.service.gameIds('owner');
  await assert.rejects(f.service.setDefault('owner','4'),{code:'BUSY'});
  blocked.release();const [a,b,c]=await Promise.all([refresh,duplicate,listing]);
  assert.equal(a.length,5);assert.deepEqual(a,b);assert.deepEqual(a,c);
  assert.deepEqual(f.calls.ids,['session-a','session-b']);
});

test('selected default and cached directory survive QR rebind of another account',async t=>{
  const f=await fixture(t);await f.service.setDefault('owner','4');
  await f.callbacks().saveSession('owner',state('renewed-a'),{playerName:'ZANTING#9403',gameIds:first});
  assert.deepEqual((await f.vault.load('owner')).defaultProfile,{accountId:'b',profileId:'21'});
  assert.equal((await f.service.gameIds('owner')).find(row=>row.isDefault).index,4);
  assert.deepEqual(f.calls.ids,[]);
});

test('legacy sessions without cached profiles require explicit refresh instead of hidden website requests',async t=>{
  const f=await fixture(t,{initial:{state:state('session-a'),savedAt:Date.now()}});
  await assert.rejects(f.service.gameIds('owner'),{code:'GAME_ID_CACHE_MISSING'});
  await assert.rejects(f.service.best50('owner'),{code:'GAME_ID_CACHE_MISSING'});
  assert.deepEqual(f.calls.ids,[]);
  assert.equal((await f.service.refresh('owner')).length,3);
  assert.equal((await f.service.gameIds('owner')).length,3);
  assert.deepEqual(f.calls.ids,['session-a']);
});
