#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, loadRankingConfig, ROOT, DEF_CONFIG_PATH, USER_CONFIG_PATH } from '../src/config.js';
import { createRankingService } from '../src/ranking-service.js';
import { renderBest50 } from '../src/render.js';
import { parsePumbility } from '../src/parser.js';
import { createService } from '../src/service.js';
import { BrowserManager } from '../src/browser.js';
import {renderLoginQr} from '../src/login-qr.js';

const [command, ...args] = process.argv.slice(2);
async function save(file, data) {
  await mkdir(path.dirname(path.resolve(file)), {recursive: true});
  await writeFile(file, data);
  console.log(`已写入 ${path.resolve(file)}`);
}
async function main() {
  if (command === 'setup') {
    const key = randomBytes(32).toString('hex');
    let yamlTemplate = await readFile(DEF_CONFIG_PATH, 'utf8');
    yamlTemplate = yamlTemplate.replace('sessionKey: ""', `sessionKey: "${key}"`);
    await mkdir(path.dirname(USER_CONFIG_PATH), { recursive: true });
    let created = true;
    await writeFile(USER_CONFIG_PATH, yamlTemplate, { flag: 'wx', mode: 0o600 }).catch(err => {
      if (err.code === 'EEXIST') {
        created = false;
        console.log('config/config.yaml 已存在，保留现有配置。');
      } else {
        throw err;
      }
    });
    if (created) {
      console.log('已创建 config/config.yaml。密钥 sessionKey 已自动生成。部署前将 publicUrl 改为自己的 HTTPS 域名。');
    }



    return;
  }
  if (command === 'render') {
    if (!args[0]) throw new Error('用法: render <profile.json> [output.jpg]');
    const input = JSON.parse(await readFile(args[0], 'utf8'));
    await save(args[1] || 'best50.jpg', await renderBest50(input));
    return;
  }
  if (command === 'parse') {
    if (!args[0]) throw new Error('用法: parse <pumbility.html> [profile.json]');
    const profile = parsePumbility(await readFile(args[0], 'utf8'));
    await save(args[1] || 'profile.json', JSON.stringify(profile, null, 2) + '\n');
    return;
  }
  if (command === 'login-local') {
    const config = loadConfig();
    const browser = new BrowserManager({...config, headless: false});
    const rl = createInterface({input: process.stdin, output: process.stdout});
    let service;
    try {
      const {context} = await browser.createLogin();
      await rl.question('请在打开的官方网页中完成登录，然后回到终端按回车。');
      // This command already owns a local login window and needs no HTTP relay.
      service = await createService(config, {createBridge: async () => ({async revoke() {}, async close() {}})});
      const state = await context.storageState();
      const profile = await service.importCookies(args[0] || 'local', JSON.stringify({cookies: state.cookies}));
      console.log(`已保存 ${profile.playerName} 的会话。运行 node bin/piu.js fetch ${args[0] || 'local'}`);
    } finally { rl.close(); await service?.close(); await browser.close(); }
    return;
  }
  if (command === 'rank-login-local') {
    const config = loadRankingConfig();
    const browser = new BrowserManager({...config, headless: false});
    const ranking = createRankingService(config);
    const rl = createInterface({input: process.stdin, output: process.stdout});
    try {
      const {context} = await browser.createLogin();
      await rl.question('请在独立窗口完成官网登录，再回到终端按回车（此会话用于每日排行榜采集）。');
      const snapshot = await ranking.setSession(await context.storageState());
      console.log(`排行榜会话已加密保存，已取得 ${snapshot.count} 条真实记录。`);
      if (config.jacketPrefetchPages) console.log(JSON.stringify(await ranking.prewarm({onlyIfEmpty: true}), null, 2));
    } finally { rl.close(); await ranking.close(); await browser.close(); }
    return;
  }
  if (['rank-capture', 'rank-daemon', 'rank-dates', 'rank-follow', 'rank-unfollow', 'rank', 'rank-preview', 'rank-prefetch', 'rank-audit'].includes(command)) {
    const ranking = createRankingService(loadRankingConfig());
    try {
      if (command === 'rank-capture') console.log(JSON.stringify(await ranking.capture(), null, 2));
      if (command === 'rank-dates') console.log(JSON.stringify(ranking.status(), null, 2));
      if (command === 'rank-audit') console.log(JSON.stringify(ranking.latestAudit(), null, 2));
      if (command === 'rank-prefetch') console.log(JSON.stringify(await ranking.prewarm(), null, 2));
      if (command === 'rank-follow' || command === 'rank-unfollow') {
        const owner = args[0] || 'local';
        const input = args.slice(1).join(' ');
        const result = input ? await ranking[command === 'rank-follow' ? 'follow' : 'unfollow'](owner, input) : ranking.listFollows(owner);
        console.log(JSON.stringify(result, null, 2));
      }
      if (command === 'rank') {
        const [owner = 'local', first, second, output = 'rank.jpg'] = args;
        await save(output, await ranking.rank(owner, first, second));
      }
      if (command === 'rank-preview') await save(args[2] || 'rank-current.jpg', await ranking.preview(args[0] || 'local', args[1]));
      if (command === 'rank-daemon') {
        ranking.start({keepAlive: true});
        console.log(`排行榜采集器已启动；下一次 01:00 GMT+8 对应 ${ranking.status().nextCaptureAt}。Ctrl+C 停止。`);
        await new Promise(resolve => {process.once('SIGINT', resolve); process.once('SIGTERM', resolve);});
      }
    } finally { await ranking.close(); }
    return;
  }
  if (command === 'fetch' || command === 'recent' || command === 'data') {
    const service = await createService(loadConfig());
    const method = {fetch:'best50',recent:'recent',data:'data'}[command];
    try { await save(args[1] || ({fetch:'best50.jpg',recent:'recent.jpg',data:'play-data.jpg'}[command]),
      await service[method](args[0] || 'local', args.slice(2).join(' '))); }
    finally { await service.close(); }
    return;
  }
  if (['ids', 'list', 'refresh', 'default'].includes(command)) {
    const service = await createService(loadConfig());
    try {
      const user = args[0] || 'local';
      if (command === 'default' || (['ids','list'].includes(command) && args[1])) {
        const selected = await service.setDefault(user, args.slice(1).join(' '));
        console.log(`默认档案已设为 ${selected.playerName}（序号 ${selected.index}）。`);
      } else {
        const rows = await service[command === 'refresh' ? 'refresh' : 'gameIds'](user);
        console.log(JSON.stringify(rows.map(row => ({index:row.index, isDefault:row.isDefault, account:row.account, gameId:row.playerName, pumbility:row.pumbility, recordCount:row.recordCount, cachedAt:row.cachedAt, authExpired:Boolean(row.authExpired)})),null,2));
      }
    }
    finally { await service.close(); }
    return;
  }
  if (command === 'serve') {
    const config = loadConfig();
    const service = await createService(config);
    try {
      const ticket = await service.login(args[0] || 'local');
      await save('login-qr.jpg', await renderLoginQr(ticket.url));
      console.log(`扫码打开独立官网登录窗口（非官方扫码授权）：\n${ticket.url}`);
      console.log('完成绑定后，停止此进程，再运行 node bin/piu.js fetch。Ctrl+C 停止。');
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    } finally { await service.close(); }
    return;
  }
  console.log([
    'PIU Best50 / 最近游玩 / 排行榜',
    '  npm run setup',
    '  node bin/piu.js render profile.json out.jpg',
    '  node bin/piu.js parse pumbility.html profile.json',
    '  node bin/piu.js login-local [user]',
    '  node bin/piu.js serve [user]',
    '  node bin/piu.js list [user] [默认档案序号]',
    '  node bin/piu.js default [user] <档案序号>',
    '  node bin/piu.js refresh [user]',
    '  node bin/piu.js fetch [user] [out.jpg] [序号 / 唯一名称 / #标签 / 完整标识]',
    '  node bin/piu.js recent [user] [out.jpg] [序号 / 唯一名称 / #标签 / 完整标识]',
    '  node bin/piu.js data [user] [out.jpg] [序号 / 唯一名称 / #标签 / 完整标识]',
    '  node bin/piu.js rank-login-local',
    '  node bin/piu.js rank-capture | rank-daemon | rank-dates | rank-audit | rank-prefetch',
    '  node bin/piu.js rank-follow owner SHAWN#1477 YINYBEST#3231 CHIPHANT#5633',
    '  node bin/piu.js rank-unfollow owner SHAWN#1477',
    '  node bin/piu.js rank owner [YYYYMMDD YYYYMMDD] [out.jpg]',
    '  node bin/piu.js rank-preview owner [YYYYMMDD] [out.jpg]',
    '  未指定 B50 / recent / data 档案时生成本地保存的默认档案；list 仅读本地缓存，refresh 才刷新。',
    '  档案名称仅限 1–12 位英文字母或数字，不含空格，大小写不敏感。',
  ].join('\n'));
}
main().catch(error => {
  // Never dump browser errors, request bodies, cookies or URLs with session identifiers.
  console.error(error.code === 'EEXIST' ? 'config/config.yaml 已存在，保留原配置。' : (error.code && error.name === 'PiuError' ? error.message : '操作失败，请检查命令参数、config/config.yaml 配置、浏览器安装及网络。'));
  process.exitCode = 1;
});
