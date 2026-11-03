import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

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
  };
  const best50 = {
    async login(...args) {calls.push(['login', ...args]); return {url: 'https://bot.example/login/token', expiresAt: Date.now() + 300_000};},
    async best50(...args) {calls.push(['best50', ...args]); return Buffer.from('PNG');},
    async gameIds(...args) {calls.push(['gameIds', ...args]); return [{gameId:'SHAWN',tag:'#1477',playerName:'SHAWN#1477',uid:'uid1',selected:true,pumbility:19014.2,recordCount:50}];},
    async close() {calls.push(['bestClose']);},
  };
  const Plugin = vm.runInNewContext(`${source}\nPiuBest50;`, {
    plugin: class {
      constructor(options) {Object.assign(this, options); this.sent = [];}
      async reply(value) {this.sent.push(value); return value;}
      addCleanup(fn) {this.cleanup = fn;}
    },
    createService: async () => best50, createRankingService: async () => ranking,
    loadConfig: () => ({}), loadRankingConfig: () => ({}),
    publicError: error => error.message, QRCode: {toBuffer: async () => Buffer.from('QR')},
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
  assert.match(app.sent.at(-1), /#piu b50 ZANTING#9403/);
  assert.match(app.sent.at(-1), /SHAWN#1477 YINYBEST#3231 CHIPHANT#5633/);
  app.e.msg = '#piu list';
  await app.gameIds();
  assert.match(app.sent.at(-1), /1\. SHAWN#1477/);
  assert.doesNotMatch(app.sent.at(-1), /uid1/);
  app.e.msg = '#piu b50 ZANTING#9403';
  await app.best50();
  assert.equal(calls.find(row => row[0] === 'best50')[2], 'ZANTING#9403');
});

test('help covers every bot command, permissions, schedule and mandatory full identities', async () => {
  const {app} = harness();
  await app.help();
  const help = app.sent.at(-1);
  assert.match(help, /^#piu help/);
  for (const command of ['#piu help', '#piu 帮助', '#piu 登录', '#piu list', '#piu b50', '#piu follow', '#piu unfollow', '#piu rank', '#piu 解绑', '#piu ranklogin']) {
    assert.ok(help.includes(command), `help must explain ${command}`);
  }
  for (const alias of ['登陆', '绑定', 'login', '账号', '游戏ID', 'ids', 'best50', '退出', 'logout']) assert.ok(help.includes(alias));
  assert.match(help, /#piu b50：生成自己首个档案/);
  assert.match(help, /#piu b50 ZANTING#9403/);
  assert.match(help, /SHAWN#1477 YINYBEST#3231 CHIPHANT#5633/);
  assert.match(help, /#piu follow \/ #piu unfollow：不带参数时查看/);
  assert.match(help, /本周一 01:00 与上周一 01:00（GMT\+8）/);
  assert.match(help, /#piu rank 20261103 20261003/);
  assert.match(help, /日期格式均为 YYYYMMDD/);
  assert.match(help, /缺失的历史快照不能比较/);
  assert.match(help, /登录、list 仅限私聊/);
  assert.match(help, /仅机器人主人私聊 #piu ranklogin/);
  assert.match(help, /按配置保活/);
  assert.match(help, /普通登录不会授权全局排行榜采集/);
  assert.match(help, /机器人在线且排行榜专用会话有效时/);
  assert.match(help, /所有显式用户标识必须使用完整的 名称#四位标签/);
  assert.doesNotMatch(help, /#piu (?:b50|follow|unfollow) (?:uid\d+|#\d{4}|SHAWN(?:\s|$)|YINBEST(?:\s|$))/i);
  const helpRule = app.rule.find(rule => rule.fnc === 'help');
  assert.ok(new RegExp(helpRule.reg).test('#piu help'));
  assert.ok(new RegExp(helpRule.reg).test('#piu 帮助'));
});
