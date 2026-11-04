import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {HELP_GROUPS,HELP_NOTES} from '../src/help-image.js';

const source = (await readFile(new URL('../apps/piu.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ').replaceAll('export class ', 'class ');
const people = [{gameId: 'SHAWN', tag: '#1477', playerKey: 'name:SHAWN#1477'}];

function harness() {
  const calls = [];
  const ranking = {
    async start() {calls.push(['start']);}, async close() {calls.push(['rankClose']);},
    async rank(...args) {calls.push(['rank', ...args]); return Buffer.from('PNG');},
    async follow(...args) {calls.push(['follow', ...args]); return {added: people, follows: people};},
    async unfollow(...args) {calls.push(['unfollow', ...args]); return {removed: people, follows: []};},
    async listFollows(...args) {calls.push(['listFollows', ...args]); return people;},
    async setSession(state) {calls.push(['setSession', state]);},
    async importCookies(input) {calls.push(['rankImportCookies', input]); return {count:1000};},
  };
  const best50 = {
    async login(...args) {calls.push(['login', ...args]); return {url: 'https://bot.example/login/token', expiresAt: Date.now() + 300_000};},
    async importCookies(...args) {calls.push(['importCookies', ...args]);},
    async unbind(...args) {calls.push(['unbind', ...args]);},
    async best50(...args) {calls.push(['best50', ...args]); return Buffer.from('PNG');},
    async recent(...args) {calls.push(['recent', ...args]); return Buffer.from('RECENT PNG');},
    async data(...args) {calls.push(['data', ...args]); return Buffer.from('DATA PNG');},
    async gameIds(...args) {calls.push(['gameIds', ...args]); return [{gameId:'SHAWN',tag:'#1477',playerName:'SHAWN#1477',uid:'uid1',selected:true,pumbility:19014.2,recordCount:50}];},
    async close() {calls.push(['bestClose']);},
  };
  const Plugin = vm.runInNewContext(`${source}\nPiuBest50;`, {
    plugin: class {
      constructor(options) {Object.assign(this, options); this.sent = [];}
      async reply(value, quote) {this.sent.push(value); calls.push(['reply', quote]); return value;}
      addCleanup(fn) {this.cleanup = fn;}
    },
    createService: async () => {calls.push(['createService']);return best50;}, createRankingService: async () => {calls.push(['createRankingService']);return ranking;},
    loadConfig: () => ({}), loadRankingConfig: () => ({}),
    publicError: error => error.message, renderLoginQr: async () => Buffer.from('QR'),
    renderHelp: async () => {calls.push(['helpImage']);return Buffer.from('HELP PNG');},
    logger: {warn: value => calls.push(['warn', value])}, console,
  });
  const app = new Plugin();
  app.e = {msg: '', user_id: 123, self_id: 456, isMaster: false};
  return {app, calls, ranking};
}

test('plugin starts daily ranking scheduler and closes both services through cleanup', async () => {
  const {app, calls} = harness();
  await app.init();
  await app.login();
  await app.cleanup();
  assert.equal(calls.filter(row => row[0] === 'start').length, 1);
  assert.equal(calls.filter(row => row[0] === 'rankClose').length, 1);
  assert.equal(calls.filter(row => row[0] === 'bestClose').length, 1);
});

test('login help and group refusal do not create a service or quote credentials', async () => {
  const {app, calls} = harness();
  app.e.msg = '#piu login help';
  await app.login();
  assert.match(app.sent.at(-1), /Network/);
  assert.equal(calls.some(row => row[0] === 'createService'), false);
  for (const group of [{isGroup:true}, {group_id:123}]) {
    Object.assign(app.e, {isGroup:false, group_id:undefined}, group);
    app.e.msg = '#piu login sid=private-test-value';
    await app.login();
    assert.match(app.sent.at(-1), /仅限私聊/);
  }
  assert.equal(calls.some(row => row[0] === 'createService'), false);
  assert.equal(app.sent.some(value => value.includes('private-test-value')), false);
  assert.ok(calls.filter(row => row[0] === 'reply').every(row => row[1] === false));
});

test('login and its aliases import credentials for the requesting owner without creating a QR or echoing them', async () => {
  const {app, calls} = harness();
  const rule = new RegExp(app.rule.find(rule => rule.fnc === 'login').reg);
  assert.ok(rule.test('#piu login'));
  assert.ok(rule.test('#piu LOGIN sid=test-token'));
  assert.ok(rule.test('#piu login [\n{"name":"sid"}\n]'));
  assert.equal(rule.test('#piu logins sid=test-token'), false);
  assert.equal(app.rule.some(rule => new RegExp(rule.reg).test('#piu cookie sid=test-token')), false);
  const inputs = ['sid=private-test-value; pref=en', '[\n{"name":"sid","value":"private-test-value","domain":"www.piugame.com"}\n]'];
  for (const alias of ['login','登录','登陆','绑定']) for (const input of inputs) {
    app.e.msg = `#piu ${alias} ${input}`;
    assert.ok(rule.test(app.e.msg));
    await app.login();
    assert.equal(calls.filter(row => row[0] === 'importCookies').at(-1)[1], '["default","456","123"]');
    assert.equal(calls.filter(row => row[0] === 'importCookies').at(-1)[2], input);
    assert.match(app.sent.at(-1), /验证成功/);
    assert.equal(app.sent.at(-1).includes('private-test-value'), false);
  }
  assert.equal(calls.some(row => row[0] === 'login'), false);
  assert.ok(calls.filter(row => row[0] === 'reply').every(row => row[1] === false));
});

test('login without credentials keeps QR login for every alias and logout aliases remove personal bindings', async () => {
  const {app,calls}=harness();
  const loginRule = new RegExp(app.rule.find(rule => rule.fnc === 'login').reg);
  const logoutRule = new RegExp(app.rule.find(rule => rule.fnc === 'logout').reg);
  for (const alias of ['login','登录','登陆','绑定']) {
    app.e.msg=`#piu ${alias}`;
    assert.ok(loginRule.test(app.e.msg));
    await app.login();
  }
  assert.equal(calls.filter(row => row[0] === 'login').length,4);
  assert.equal(calls.some(row => row[0] === 'importCookies'),false);
  for (const alias of ['logout','解绑','退出']) {
    app.e.msg=`#piu ${alias}`;
    assert.ok(logoutRule.test(app.e.msg));
    await app.logout();
  }
  assert.equal(logoutRule.test('#piu logouts'),false);
  assert.equal(calls.filter(row => row[0] === 'unbind').length,3);
  assert.ok(calls.filter(row => row[0] === 'unbind').every(row => row[1] === '["default","456","123"]'));
  assert.match(app.sent.at(-1),/全部个人 PIU 账号/);
  for (const group of [{isGroup:true},{group_id:987}]) {
    Object.assign(app.e,{isGroup:false,group_id:undefined,msg:'#piu logout'},group);
    await app.logout();
    assert.equal(calls.filter(row => row[0] === 'unbind').at(-1)[1],'["default","456","123"]');
  }
  assert.equal(calls.filter(row => row[0] === 'unbind').length,5);
  assert.equal(calls.some(row => row[0] === 'createRankingService'),false,'logout must only remove the caller’s personal bindings');
});

test('rank commands pass the current owner and exact date order while rejecting incomplete dates', async () => {
  const {app, calls} = harness();
  app.e.msg = '#piu rank';
  await app.rank();
  app.e.msg = '#piu rank 20261103 20261003';
  await app.rank();
  app.e.msg = '#piu rank 20261103';
  await app.rank();
  const rows = calls.filter(row => row[0] === 'rank');
  assert.equal(rows.length, 2);
  assert.equal(rows[0][1], '["default","456","123"]');
  assert.equal(JSON.stringify(rows[1].slice(2)), '["20261103","20261003"]');
  assert.match(app.sent.at(-1), /两个日期/);
});

test('follow and unfollow pass whole batches and empty commands show owner-scoped lists', async () => {
  const {app, calls} = harness();
  app.e.msg = '#piu follow SHAWN#1477 YINYBEST#3231 CHIPHANT#5633';
  await app.follow();
  app.e.msg = '#piu unfollow SHAWN#1477 YINYBEST#3231 CHIPHANT#5633';
  await app.unfollow();
  app.e.msg = '#piu follow';
  await app.follow();
  assert.equal(calls.find(row => row[0] === 'follow')[2], 'SHAWN#1477 YINYBEST#3231 CHIPHANT#5633');
  assert.equal(calls.find(row => row[0] === 'unfollow')[2], 'SHAWN#1477 YINYBEST#3231 CHIPHANT#5633');
  assert.equal(calls.find(row => row[0] === 'listFollows')[1], '["default","456","123"]');
  assert.match(app.sent.at(-1), /SHAWN#1477/);
});

test('ranklogin requires master and private chat before creating a QR or saving any session', async () => {
  const {app, calls} = harness();
  assert.equal(app.rule.find(rule => rule.fnc === 'rankLogin').permission, 'master');
  await app.rankLogin();
  app.e.isMaster = true;
  app.e.isGroup = true;
  await app.rankLogin();
  assert.equal(calls.some(row => row[0] === 'login'), false);
  app.e.isGroup = false;
  await app.rankLogin();
  const login = calls.find(row => row[0] === 'login');
  assert.equal(login[1], '["default","456","123"]');
  const state = {cookies: []};
  await login[2].onBoundSession(state);
  assert.equal(calls.find(row => row[0] === 'setSession')[1], state);
  assert.match(app.sent.at(-2), /用于机器人每日排行榜采集/);
  assert.match(app.sent.at(-2), /加密保存专用会话，并按配置保活/);
});

test('ordinary login never authorizes global ranking capture', async () => {
  const {app, calls} = harness();
  await app.login();
  assert.equal(calls.find(row => row[0] === 'login').length, 2);
  assert.equal(calls.some(row => row[0] === 'setSession'), false);
});

test('ranking scheduler init failure is logged without breaking the plugin', async () => {
  const {app, calls, ranking} = harness();
  ranking.start = async () => {throw new Error('Ranking login required');};
  await app.init();
  assert.match(calls.find(row => row[0] === 'warn')[1], /Ranking login required/);
});

test('help, private account lists and B50 command forwarding use full canonical identities', async () => {
  const {app, calls} = harness();
  await app.help();
  assert.equal(app.sent.at(-1).type,'image');
  assert.equal(calls.filter(row=>row[0]==='helpImage').length,1);
  app.e.msg = '#piu list';
  await app.gameIds();
  assert.match(app.sent.at(-1), /1\. SHAWN#1477/);
  assert.doesNotMatch(app.sent.at(-1), /uid1/);
  app.e.msg = '#piu b50 ZANTING#9403';
  await app.best50();
  assert.equal(calls.find(row => row[0] === 'best50')[2], 'ZANTING#9403');
});

test('help covers every bot command, permissions, schedule and mandatory full identities', async () => {
  const {app,calls} = harness();
  await app.help();
  assert.equal(app.sent.at(-1).type,'image');
  assert.equal(app.sent.at(-1).file.toString(),'HELP PNG');
  assert.equal(calls.some(row=>row[0]==='createService'),false,'help must work without login configuration');
  const help=[...HELP_NOTES,...HELP_GROUPS.flatMap(group=>group.items.map(item=>[item.command,item.description,item.aliases].filter(Boolean).join(' ')))].join('\n');
  for (const command of ['#piu help', '#piu 帮助', '#piu login', '#piu list', '#piu b50', '#piu recent', '#piu data', '#piu follow', '#piu unfollow', '#piu rank', '#piu logout', '#piu ranklogin']) {
    assert.ok(help.includes(command), `help must explain ${command}`);
  }
  for (const alias of ['登录', '登陆', '绑定', '账号', '游戏ID', 'ids', 'best50', '解绑', '退出']) assert.ok(help.includes(alias));
  assert.doesNotMatch(help, /#piu cookie\b/);
  assert.match(help, /不指定档案时.*首个档案/);
  assert.match(help, /#piu b50 ZANTING#9403/);
  assert.match(help, /SHAWN#1477 YINYBEST#3231 CHIPHANT#5633/);
  assert.match(help, /follow \/ unfollow 不带参数时查看/);
  assert.match(help, /本周一 01:00 与上周一 01:00（GMT\+8）/);
  assert.match(help, /#piu rank 20261103 20261102/);
  assert.match(help, /日期为 YYYYMMDD/);
  assert.match(help, /缺失的历史快照不能比较/);
  assert.match(help, /login、list 仅限私聊/);
  assert.match(help, /#piu ranklogin(?: \[Cookie 内容\])? 仅机器人主人私聊/);
  assert.match(help, /按配置保活/);
  assert.match(help, /普通个人登录不会授权全局排行榜采集/);
  assert.match(help, /机器人在线且排行榜专用会话有效时/);
  assert.match(help, /所有显式档案标识都用完整的 名称#四位标签/);
  assert.doesNotMatch(help, /#piu (?:b50|follow|unfollow) (?:uid\d+|#\d{4}|SHAWN(?:\s|$)|YINBEST(?:\s|$))/i);
  const helpRule = app.rule.find(rule => rule.fnc === 'help');
  assert.ok(new RegExp(helpRule.reg).test('#piu help'));
  assert.ok(new RegExp(helpRule.reg).test('#piu 帮助'));
});

test('data command forwards only the requesting owner and supports an optional full profile', async () => {
  const {app,calls}=harness();
  const rule=new RegExp(app.rule.find(rule=>rule.fnc==='playData').reg);
  assert.ok(rule.test('#piu data'));
  assert.ok(rule.test('#piu data ZANTING#9403'));
  assert.equal(rule.test('#piu database'),false);
  app.e.msg='#piu data';await app.playData();
  app.e.msg='#piu data ZANTING#9403';await app.playData();
  assert.equal(calls.filter(row=>row[0]==='data').length,2);
  assert.equal(calls.find(row=>row[0]==='data')[1],'["default","456","123"]');
  assert.equal(calls.find(row=>row[0]==='data')[2],'');
  assert.equal(calls.filter(row=>row[0]==='data')[1][2],'ZANTING#9403');
  app.e.msg='#piu data @someone';await app.playData();
  assert.equal(calls.filter(row=>row[0]==='data').length,2);
});

test('recent command forwards the authenticated owner and optional full profile selector', async () => {
  const {app,calls} = harness();
  const rule = new RegExp(app.rule.find(rule => rule.fnc === 'recent').reg);
  assert.ok(rule.test('#piu recent'));
  assert.ok(rule.test('#piu recent ZANTING#9403'));
  assert.equal(rule.test('#piu recently'), false);
  app.e.msg = '#piu recent';
  await app.recent();
  app.e.msg = '#piu recent ZANTING#9403';
  await app.recent();
  assert.equal(calls.filter(row => row[0] === 'recent').length, 2);
  assert.equal(calls.find(row => row[0] === 'recent')[1], '["default","456","123"]');
  assert.equal(calls.find(row => row[0] === 'recent')[2], '');
  assert.equal(calls.filter(row => row[0] === 'recent')[1][2], 'ZANTING#9403');
  app.e.msg = '#piu recent @someone';
  await app.recent();
  assert.equal(calls.filter(row => row[0] === 'recent').length, 2);
});

test('ranklogin accepts Cookie headers and multiline JSON without creating personal login sessions',async()=>{
  const {app,calls}=harness();app.e.isMaster=true;
  const rule=new RegExp(app.rule.find(row=>row.fnc==='rankLogin').reg);
  assert.ok(rule.test('#piu ranklogin'));
  assert.ok(rule.test('#piu RANKLOGIN sid=test-only'));
  assert.equal(rule.test('#piu ranklogins sid=test-only'),false);
  for(const input of ['sid=private-test-value; pref=en','[\n{"name":"sid","value":"private-test-value","domain":".piugame.com"}\n]']){
    app.e.msg=`#piu ranklogin ${input}`;
    assert.ok(rule.test(app.e.msg));await app.rankLogin();
    assert.equal(calls.filter(row=>row[0]==='rankImportCookies').at(-1)[1],input);
    assert.match(app.sent.at(-1),/前 1000 名/);
    assert.ok(!app.sent.at(-1).includes('private-test-value'));
  }
  assert.equal(calls.some(row=>['login','createService','setSession'].includes(row[0])),false);
  assert.ok(calls.filter(row=>row[0]==='reply').every(row=>row[1]===false));
});

test('ranking Cookie help and authorization checks never create services or quote credentials',async()=>{
  const {app,calls}=harness();app.e.msg='#piu ranklogin sid=private-test-value';
  await app.rankLogin();assert.match(app.sent.at(-1),/只有机器人主人/);
  app.e.isMaster=true;
  for(const group of [{isGroup:true},{group_id:987}]){
    Object.assign(app.e,{isGroup:false,group_id:undefined},group);
    await app.rankLogin();assert.match(app.sent.at(-1),/私聊/);
  }
  Object.assign(app.e,{isGroup:false,group_id:undefined,msg:'#piu ranklogin help'});
  await app.rankLogin();assert.match(app.sent.at(-1),/无需反向代理/);
  assert.equal(calls.some(row=>['createService','createRankingService','rankImportCookies'].includes(row[0])),false);
  assert.ok(app.sent.every(value=>!value.includes('private-test-value')));
  assert.ok(calls.filter(row=>row[0]==='reply').every(row=>row[1]===false));
});

test('all group members share follow, unfollow, list and rank while other groups and private lists remain isolated',async()=>{
  const {app,calls}=harness();
  Object.assign(app.e,{isGroup:true,group_id:987,msg:'#piu follow SHAWN#1477'});
  await app.follow();
  const owner=calls.find(row=>row[0]==='follow')[1];
  assert.equal(owner,'["default","456","group","987"]');
  app.e.user_id=999;app.e.msg='#piu unfollow SHAWN#1477';await app.unfollow();
  assert.equal(calls.find(row=>row[0]==='unfollow')[1],owner);
  for(const [method,msg] of [['follow','#piu follow'],['unfollow','#piu unfollow'],['rank','#piu rank']]){
    app.e.msg=msg;await app[method]();
    assert.equal(calls.filter(row=>row[0]===(method==='rank'?'rank':'listFollows')).at(-1)[1],owner);
    if(method!=='rank')assert.match(app.sent.at(-1),/本群.*关注列表/);
  }
  app.e.group_id=988;app.e.msg='#piu follow SHAWN#1477';await app.follow();
  assert.notEqual(calls.filter(row=>row[0]==='follow').at(-1)[1],owner);
  Object.assign(app.e,{isGroup:false,group_id:undefined,msg:'#piu follow'});await app.follow();
  assert.equal(calls.filter(row=>row[0]==='listFollows').at(-1)[1],'["default","456","999"]');
  assert.match(app.sent.at(-1),/自己的 PIU 关注列表/);
  assert.equal(app.rule.find(row=>row.fnc==='follow').permission,undefined);
  assert.equal(app.rule.find(row=>row.fnc==='unfollow').permission,undefined);
});
