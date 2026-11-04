import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';
import { PiuError } from '../src/errors.js';

function gate() {
  let release, started;
  return {waiting: new Promise(resolve => { release = resolve; }), ready: new Promise(resolve => { started = resolve; }),
    release: () => release(), start: () => started()};
}
const state = label => ({cookies: [{name: 'sid', domain: '.piugame.com', path: '/', value: label}], origins: []});
async function fixture(t, overrides = {}) {
  const records = new Map([['owner', {state: state('old'), savedAt: Date.now()}]]);
  const calls = {fetch: [], recent: [], data: [], ids: 0, saves: [], deletes: [], imports: [], closes: 0, revokes: []};
  let callbacks;
  const vault = {
    async load(key) { return structuredClone(records.get(key) ?? null); },
    async save(key, value) { calls.saves.push(key); records.set(key, structuredClone(value)); },
    async delete(key) { calls.deletes.push(key); records.delete(key); },
  };
  const service = await createService({dataDir: '/unused', cacheMs: 120000, maxFetches: 3, sessionMaxAgeMs: 86400000}, {
    vault, browser: {async close() {}, async context(saved) {
      calls.imports.push(saved);
      if (overrides.onContext) await overrides.onContext();
      return {async newPage() { return {saved}; }, async storageState() { return overrides.importedState ?? saved; }, async close() { calls.closes++; }};
    }},
    readProfile: async (page, options) => {
      assert.equal(options.paginate, false);
      if (overrides.onValidate) return overrides.onValidate(page);
      return {playerName: 'IMPORTED#1234'};
    },
    createBridge: async options => { callbacks = options; return {async createTicket() {
      if (overrides.onTicket) await overrides.onTicket();
      return {url: 'http://localhost/login', expiresAt: overrides.ticketExpiresAt ?? Date.now() + 300000};
    }, async revoke(key) { calls.revokes.push(key); }, async close() {}}; },
    fetchProfile: async (_browser, saved, {gameId}) => {
      calls.fetch.push(gameId);
      if (overrides.onFetch) await overrides.onFetch(gameId);
      return {profile: {label: `${saved.cookies[0].value}:${gameId || 'current'}`}, images: new Map(), state: saved};
    },
    fetchRecent: async (_browser, saved, {gameId}) => {
      calls.recent.push(gameId);
      if (overrides.onRecent) await overrides.onRecent(gameId);
      return {profile: {kind:'recent',label:`${saved.cookies[0].value}:${gameId || 'current'}`}, images:new Map(), state:saved};
    },
    fetchPlayData: async (_browser,saved,{gameId}) => {
      calls.data.push(gameId);
      if(overrides.onData)await overrides.onData(gameId);
      return {profile:{label:`${saved.cookies[0].value}:${gameId||'current'}`},images:new Map(),state:saved};
    },
    fetchGameIds: async (_browser, saved) => {
      calls.ids++;
      if (overrides.onIds) await overrides.onIds();
      return {gameIds: [{id: 'bound', uid: 'uid1', playerName: 'ZANTING#9403', gameId: 'ZANTING', tag: '#9403', selected: true, pumbility: 17841.83, recordCount: 50}], state: saved};
    },
    renderBest50: async profile => Buffer.from(profile.label),
    renderRecent: async profile => Buffer.from(`recent:${profile.label}`),
    renderPlayData: async profile => Buffer.from(`data:${profile.label}`),
  });
  t.after(() => service.close());
  return {service, records, calls, callbacks};
}

test('bare b50 uses first card and explicit selectors require complete name and tag', async t => {
  const f = await fixture(t);
  const first = await f.service.best50('owner');
  assert.equal(first.toString(), 'old:current');
  assert.strictEqual(await f.service.best50('owner', ''), first);
  const named = await f.service.best50('owner', '  ZANTING   #9403 ');
  assert.equal(named.toString(), 'old:ZANTING#9403');
  assert.strictEqual(await f.service.best50('owner', 'ZANTING#9403'), named);
  for (const input of ['ZANTING', '#9403', '9403', 'uid1', 'uid2', '__first__']) {
    await assert.rejects(f.service.best50('owner', input), {code: 'GAME_ID_FORMAT'});
  }
  assert.strictEqual(await f.service.best50('owner'), first);
  assert.deepEqual(f.calls.fetch, ['', 'ZANTING#9403']);
  await assert.rejects(f.service.best50('another', 'ZANTING#9403'), {code: 'AUTH_REQUIRED'});
});

test('recent uses its own cache, validates full IDs, and requires a bound personal session', async t => {
  const f = await fixture(t);
  const best = await f.service.best50('owner');
  const recent = await f.service.recent('owner');
  assert.equal(recent.toString(), 'recent:old:current');
  assert.strictEqual(await f.service.recent('owner'), recent);
  assert.strictEqual(await f.service.best50('owner'), best);
  assert.equal((await f.service.recent('owner','ZANTING#9403')).toString(), 'recent:old:ZANTING#9403');
  assert.deepEqual(f.calls.recent, ['', 'ZANTING#9403']);
  for (const selector of ['#9403','ZANTING','uid1']) await assert.rejects(f.service.recent('owner',selector), {code:'GAME_ID_FORMAT'});
  await assert.rejects(f.service.recent('another'), {code:'AUTH_REQUIRED'});
  await f.service.unbind('owner');
  await assert.rejects(f.service.recent('owner'), {code:'AUTH_REQUIRED'});
});

test('Play Data requires a bound session and has a separate per-profile image cache',async t=>{
  const f=await fixture(t);
  const best=await f.service.best50('owner'),recent=await f.service.recent('owner'),data=await f.service.data('owner');
  assert.equal(data.toString(),'data:old:current');
  assert.strictEqual(await f.service.data('owner'),data);
  assert.strictEqual(await f.service.best50('owner'),best);
  assert.strictEqual(await f.service.recent('owner'),recent);
  assert.equal((await f.service.data('owner','ZANTING#9403')).toString(),'data:old:ZANTING#9403');
  assert.deepEqual(f.calls.data,['','ZANTING#9403']);
  await assert.rejects(f.service.data('other'),{code:'AUTH_REQUIRED'});
  await assert.rejects(f.service.data('owner','#9403'),{code:'GAME_ID_FORMAT'});
  await f.service.unbind('owner');
  await assert.rejects(f.service.data('owner'),{code:'AUTH_REQUIRED'});
});

test('Play Data locks account switching against B50, recent and listing',async t=>{
  const blocked=gate();
  const f=await fixture(t,{onData:async()=>{blocked.start();await blocked.waiting;}});
  const data=f.service.data('owner');await blocked.ready;
  const same=f.service.data('owner');
  await assert.rejects(f.service.best50('owner'),{code:'BUSY'});
  await assert.rejects(f.service.recent('owner'),{code:'BUSY'});
  await assert.rejects(f.service.gameIds('owner'),{code:'BUSY'});
  blocked.release();
  const [left,right]=await Promise.all([data,same]);
  assert.strictEqual(left,right);
});

test('recent shares the account-switch lock with B50 and merges identical in-flight recent requests', async t => {
  const blocked = gate();
  const f = await fixture(t, {onRecent:async()=>{blocked.start();await blocked.waiting;}});
  await f.service.best50('owner');
  const recent = f.service.recent('owner');
  await blocked.ready;
  const same = f.service.recent('owner');
  await assert.rejects(f.service.best50('owner'), {code:'BUSY'});
  await assert.rejects(f.service.gameIds('owner'), {code:'BUSY'});
  await assert.rejects(f.service.recent('owner','ZANTING#9403'), {code:'BUSY'});
  blocked.release();
  const [left,right] = await Promise.all([recent,same]);
  assert.strictEqual(left,right);
  assert.deepEqual(f.calls.recent, ['']);
});

test('repeated bare b50 calls share an in-flight first-card request', async t => {
  const blocked = gate();
  const f = await fixture(t, {onFetch: async selector => { if (selector === '') { blocked.start(); await blocked.waiting; } }});
  const first = f.service.best50('owner');
  await blocked.ready;
  const same = f.service.best50('owner', '');
  blocked.release();
  const [left, right] = await Promise.all([first, same]);
  assert.strictEqual(left, right);
  assert.deepEqual(f.calls.fetch, ['']);
});

test('same image query reuses a task while another selector, cached card, or listing is busy', async t => {
  const blocked = gate();
  const f = await fixture(t, {onFetch: async selector => { if (selector === 'ZANTING#9403') { blocked.start(); await blocked.waiting; } }});
  await f.service.best50('owner', 'OTHER#1111');
  const first = f.service.best50('owner', 'ZANTING#9403');
  await blocked.ready;
  const same = f.service.best50('owner', 'ZANTING#9403');
  await assert.rejects(f.service.best50('owner', 'OTHER#1111'), {code: 'BUSY'});
  await assert.rejects(f.service.gameIds('owner'), {code: 'BUSY'});
  await assert.rejects(f.service.login('owner'), {code: 'BUSY'});
  blocked.release();
  const [left, right] = await Promise.all([first, same]);
  assert.strictEqual(left, right);
  assert.deepEqual(f.calls.fetch, ['OTHER#1111', 'ZANTING#9403']);
});

test('listing shares the account lock, caches all card summaries, and returns independent snapshots', async t => {
  const blocked = gate();
  const f = await fixture(t, {onIds: async () => { blocked.start(); await blocked.waiting; }});
  const first = f.service.gameIds('owner');
  await blocked.ready;
  const same = f.service.gameIds('owner');
  await assert.rejects(f.service.best50('owner', 'ZANTING#9403'), {code: 'BUSY'});
  blocked.release();
  const [left, right] = await Promise.all([first, same]);
  assert.equal(left[0].pumbility, 17841.83);
  assert.equal(left[0].uid, 'uid1');
  assert.deepEqual(left, right);
  left[0].playerName = 'modified';
  const cached = await f.service.gameIds('owner');
  assert.equal(cached[0].playerName, 'ZANTING#9403');
  assert.equal(f.calls.ids, 1);
});

test('a fresh list invalidates the first-card default while preserving complete identity images', async t => {
  const f = await fixture(t);
  await f.service.best50('owner');
  const named = await f.service.best50('owner', 'ZANTING#9403');
  await f.service.gameIds('owner');
  assert.strictEqual(await f.service.best50('owner', 'ZANTING#9403'), named);
  await f.service.best50('owner');
  assert.deepEqual(f.calls.fetch, ['', 'ZANTING#9403', '']);
});

test('unbind waits for in-flight fetch then removes every card and summary cache', async t => {
  const blocked = gate();
  const f = await fixture(t, {onFetch: async selector => { if (selector === 'ZANTING#9403') { blocked.start(); await blocked.waiting; } }});
  await f.service.best50('owner', 'OTHER#1111');
  await f.service.gameIds('owner');
  const fetching = f.service.best50('owner', 'ZANTING#9403');
  await blocked.ready;
  const unbind = f.service.unbind('owner');
  await assert.rejects(f.service.best50('owner', 'OTHER#1111'), {code: 'BUSY'});
  await assert.rejects(f.service.gameIds('owner'), {code: 'BUSY'});
  assert.equal(f.calls.deletes.length, 0);
  blocked.release();
  await fetching;
  await unbind;
  assert.equal(f.records.has('owner'), false);
  await assert.rejects(f.service.best50('owner', 'OTHER#1111'), {code: 'AUTH_REQUIRED'});
  await assert.rejects(f.service.gameIds('owner'), {code: 'AUTH_REQUIRED'});
});

test('rebind waits for pending fetch and clears card images plus the full account summary', async t => {
  const blocked = gate();
  const f = await fixture(t, {onFetch: async selector => { if (selector === 'ZANTING#9403') { blocked.start(); await blocked.waiting; } }});
  await f.service.best50('owner', 'OTHER#1111');
  await f.service.gameIds('owner');
  const fetching = f.service.best50('owner', 'ZANTING#9403');
  await blocked.ready;
  const rebinding = f.callbacks.saveSession('owner', state('new'));
  await assert.rejects(f.service.gameIds('owner'), {code: 'BUSY'});
  blocked.release();
  await fetching;
  await rebinding;
  assert.equal((await f.service.best50('owner', 'OTHER#1111')).toString(), 'new:OTHER#1111');
  await f.service.gameIds('owner');
  assert.equal(f.calls.ids, 2);
  assert.equal((await f.service.best50('owner', 'ZANTING#9403')).toString(), 'new:ZANTING#9403');
});

test('explicit ranking login receives full state only once after normal user state is saved', async t => {
  const f = await fixture(t);
  const fullState = {cookies: [...state('ranking').cookies, {name:'sso', domain:'api.am-pass.net', path:'/', value:'sso-state'}], origins: []};
  const received = [];
  await f.service.login('owner', {onBoundSession: async value => {
    assert.equal(f.records.get('owner').state.cookies.length, 1);
    received.push(value);
  }});
  await f.callbacks.saveSession('owner', fullState);
  await f.callbacks.saveSession('owner', fullState);
  assert.equal(received.length, 1);
  assert.strictEqual(received[0], fullState);
  assert.equal(f.records.get('owner').state.cookies.some(cookie => cookie.domain === 'api.am-pass.net'), false);
});

test('ordinary replacement login and unbind revoke pending global-ranking authorization', async t => {
  const f = await fixture(t);
  let authorized = 0;
  await f.service.login('owner', {onBoundSession: async () => {authorized++;}});
  await f.service.login('owner');
  await f.callbacks.saveSession('owner', state('normal'));
  assert.equal(authorized, 0);
  await f.service.login('owner', {onBoundSession: async () => {authorized++;}});
  await f.service.unbind('owner');
  await f.service.login('owner');
  await f.callbacks.saveSession('owner', state('normal-again'));
  assert.equal(authorized, 0);
});

test('failed ranking persistence remains retryable, while expired authorization cannot save a global session', async t => {
  const f = await fixture(t);
  let attempts = 0;
  await f.service.login('owner', {onBoundSession: async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary ranking storage failure');
  }});
  await assert.rejects(f.callbacks.saveSession('owner', state('new')), /temporary ranking storage failure/);
  await f.callbacks.saveSession('owner', state('new'));
  await f.callbacks.saveSession('owner', state('new'));
  assert.equal(attempts, 2);
  const expired = await fixture(t, {ticketExpiresAt: Date.now() - 1000});
  await expired.service.login('owner', {onBoundSession: async () => {attempts++;}});
  await expired.callbacks.saveSession('owner', state('late'));
  assert.equal(attempts, 2);
});

test('Cookie import verifies first, saves refreshed PIU state, clears caches and drops pending ranking authorization', async t => {
  const refreshed = {cookies: [...state('refreshed').cookies, {name: 'sso', value: 'foreign', domain: 'api.am-pass.net', path: '/'}], origins: []};
  const f = await fixture(t, {importedState: refreshed, onValidate: async page => {
    assert.equal(page.saved.cookies[0].value, 'submitted');
    assert.equal(f.records.get('owner').state.cookies[0].value, 'old');
    return {playerName: 'IMPORTED#1234'};
  }});
  const cached = await f.service.best50('owner');
  await f.service.gameIds('owner');
  let authorized = 0;
  await f.service.login('owner', {onBoundSession: async () => { authorized++; }});
  const profile = await f.service.importCookies('owner', 'sid=submitted');
  assert.equal(profile.playerName, 'IMPORTED#1234');
  assert.equal(f.records.get('owner').state.cookies[0].value, 'refreshed');
  assert.equal(f.records.get('owner').state.cookies.length, 1);
  assert.deepEqual(f.calls.revokes, ['owner']);
  assert.equal(f.calls.closes, 1);
  assert.equal(authorized, 0);
  assert.notStrictEqual(await f.service.best50('owner'), cached);
  await f.service.gameIds('owner');
  assert.equal(f.calls.ids, 2);
  await f.callbacks.saveSession('owner', state('later'));
  assert.equal(authorized, 0);
});

test('invalid or rejected Cookie imports preserve the existing session and cache, and hide browser credentials', async t => {
  for (const onValidate of [async () => { throw new PiuError('AUTH_REQUIRED', 'login failed'); }, async () => { throw new Error('sid=secret-never-echo'); }]) {
    const f = await fixture(t, {onValidate});
    const cached = await f.service.best50('owner');
    const priorSaves = f.calls.saves.length;
    await assert.rejects(f.service.importCookies('owner', 'sid=secret-never-echo'), error => !error.message.includes('secret-never-echo'));
    assert.equal(f.records.get('owner').state.cookies[0].value, 'old');
    assert.equal(f.calls.saves.length, priorSaves);
    assert.strictEqual(await f.service.best50('owner'), cached);
    assert.equal(f.calls.closes, 1);
    await assert.rejects(f.service.importCookies('owner', 'bad'), {code: 'COOKIE_FORMAT'});
    assert.equal(f.calls.imports.length, 1);
  }
});

test('Cookie validation holds account and fetch limits while unbind waits and cannot resurrect the session', async t => {
  const blocked = gate();
  const f = await fixture(t, {onValidate: async () => { blocked.start(); await blocked.waiting; return {playerName: 'IMPORTED#1234'}; }});
  const importing = f.service.importCookies('owner', 'sid=submitted');
  await blocked.ready;
  for (const task of [f.service.best50('owner'), f.service.recent('owner'), f.service.gameIds('owner'), f.service.login('owner'), f.service.importCookies('owner', 'sid=other')]) {
    await assert.rejects(task, {code: 'BUSY'});
  }
  const unbinding = f.service.unbind('owner');
  assert.equal(f.calls.deletes.length, 0);
  blocked.release();
  await Promise.all([importing, unbinding]);
  assert.equal(f.records.has('owner'), false);
  await assert.rejects(f.service.best50('owner'), {code: 'AUTH_REQUIRED'});
});

test('Cookie imports reject an active query or ticket reservation and recover after completion', async t => {
  const querying = gate();
  const f = await fixture(t, {onFetch: async () => { querying.start(); await querying.waiting; }});
  const query = f.service.best50('owner');
  await querying.ready;
  await assert.rejects(f.service.importCookies('owner', 'sid=submitted'), {code: 'BUSY'});
  querying.release();
  await query;
  await f.service.importCookies('owner', 'sid=submitted');
  const ticketing = gate();
  const g = await fixture(t, {onTicket: async () => { ticketing.start(); await ticketing.waiting; }});
  const login = g.service.login('owner');
  await ticketing.ready;
  await assert.rejects(g.service.importCookies('owner', 'sid=submitted'), {code: 'BUSY'});
  ticketing.release();
  await login;
  await g.service.importCookies('owner', 'sid=submitted');
});

test('Cookie validations share the global fetch limit and release it after failures', async t => {
  const blocked = gate();
  let validations = 0;
  const f = await fixture(t, {onValidate: async () => {
    if (++validations === 3) blocked.start();
    await blocked.waiting;
    throw new PiuError('AUTH_REQUIRED', 'expired');
  }});
  const attempts = ['a', 'b', 'c'].map(user => assert.rejects(f.service.importCookies(user, 'sid=submitted'), {code: 'AUTH_REQUIRED'}));
  await blocked.ready;
  await assert.rejects(f.service.importCookies('d', 'sid=submitted'), {code: 'BUSY'});
  blocked.release();
  await Promise.all(attempts);
  await assert.rejects(f.service.importCookies('d', 'sid=submitted'), {code: 'AUTH_REQUIRED'});
  assert.equal(f.calls.closes, 4);
});
