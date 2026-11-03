import plugin from '../../../lib/plugins/plugin.js';
import QRCode from 'qrcode';
import { createService } from '../src/service.js';
import { createRankingService } from '../src/ranking-service.js';
import { loadConfig, loadRankingConfig } from '../src/config.js';
import { publicError } from '../src/errors.js';

let servicePromise;
let rankingPromise;
function service() {
  if (!servicePromise) servicePromise = createService(loadConfig()).catch(error => {servicePromise = undefined; throw error;});
  return servicePromise;
}
function rankingService() {
  if (!rankingPromise) rankingPromise = Promise.resolve().then(() => createRankingService(loadRankingConfig()))
    .catch(error => {rankingPromise = undefined; throw error;});
  return rankingPromise;
}
export function identity(e) {
  if (e.user_id === undefined || (e.self_id ?? e.bot?.uin) === undefined) throw new Error('Missing bot/user identity');
  return JSON.stringify([String(e.bot?.adapter?.id ?? e.adapter?.id ?? 'default'), String(e.self_id ?? e.bot?.uin), String(e.user_id)]);
}
const image = buffer => globalThis.segment?.image(buffer) ?? {type: 'image', file: buffer};
const message = event => String(event.msg ?? event.raw_message ?? '');
const followNames = entries => entries.map(entry => `${entry.gameId}${entry.tag}`).join('\n');

export class PiuBest50 extends plugin {
  constructor() {
    super({name: 'PIU Best50', dsc: 'PIU Pumbility 成绩图', event: 'message', priority: 5000,
      rule: [{reg: '^#?(?:piu|PIU)\\s*(?:帮助|help)$', fnc: 'help'},
        {reg: '^#?(?:piu|PIU)\\s*(?:登录|登陆|绑定|login)$', fnc: 'login'},
        {reg: '^#?(?:piu|PIU)\\s*(?:b50|B50|best50|Best50)(?:\\s+[^@\\r\\n]{1,160})?\\s*$', fnc: 'best50'},
        {reg: '^#?(?:piu|PIU)\\s*(?:list|LIST|账号|游戏ID|游戏id|ids|IDS)$', fnc: 'gameIds'},
        {reg: '^#?(?:piu|PIU)\\s*(?:ranklogin|RANKLOGIN)\\s*$', fnc: 'rankLogin', permission: 'master'},
        {reg: '^#?(?:piu|PIU)\\s*(?:rank|RANK)(?:\\s+[^\\r\\n]{1,80})?\\s*$', fnc: 'rank'},
        {reg: '^#?(?:piu|PIU)\\s*(?:follow|FOLLOW)(?:\\s+[^\\r\\n]{1,1000})?\\s*$', fnc: 'follow'},
        {reg: '^#?(?:piu|PIU)\\s*(?:unfollow|UNFOLLOW)(?:\\s+[^\\r\\n]{1,1000})?\\s*$', fnc: 'unfollow'},
        {reg: '^#?(?:piu|PIU)\\s*(?:解绑|退出|logout)$', fnc: 'unbind'}]});
  }
  async init() {
    if (typeof this.addCleanup === 'function') this.addCleanup(async () => {
      const current = [servicePromise, rankingPromise].filter(Boolean);
      servicePromise = undefined; rankingPromise = undefined;
      await Promise.allSettled(current.map(async promise => (await promise).close()));
    });
    try { await (await rankingService()).start(); }
    catch (error) {
      if (globalThis.logger?.warn) globalThis.logger.warn(`[PIU rank] ${error.message}`);
      else console.warn(`[PIU rank] ${error.message}`);
    }
  }
  async help() {
    return this.reply([
      '#piu help · PIU 命令帮助',
      '#piu help / #piu 帮助：查看本说明。',
      '私聊 #piu 登录：领取二维码，打开独立窗口完成官网登录并绑定自己的会话；别名：登陆、绑定、login。',
      '私聊 #piu list：列出自己账号的全部档案、完整名称#标签及 Pumbility；别名：账号、游戏ID、ids。',
      '#piu b50：生成自己首个档案的 Pumbility Best50 图片；别名：best50。',
      '#piu b50 ZANTING#9403：指定自己账号内的完整名称#四位标签生成图片。',
      '#piu follow SHAWN#1477 YINYBEST#3231 CHIPHANT#5633：批量加入自己的关注列表。',
      '#piu unfollow SHAWN#1477 YINYBEST#3231：批量移出自己的关注列表。',
      '#piu follow / #piu unfollow：不带参数时查看自己的关注列表。',
      '#piu rank：生成关注列表比较图，默认比较本周一 01:00 与上周一 01:00（GMT+8）的快照。',
      '#piu rank 20261103 20261003：比较这两个日期 01:00（GMT+8）的快照，日期格式均为 YYYYMMDD。缺失的历史快照不能比较，也不会补造。',
      '#piu 解绑：删除自己保存的登录会话和成绩图片缓存；别名：退出、logout。',
      '仅机器人主人私聊 #piu ranklogin：登录并授权全局排行榜采集专用会话，服务器会加密保存并按配置保活。普通登录不会授权全局排行榜采集。',
      '登录、list 仅限私聊，ranklogin 还要求机器人主人权限；其余命令可在群聊或私聊使用，关注列表和账号绑定均按发命令的用户保存。',
      '所有显式用户标识必须使用完整的 名称#四位标签，例如 SHAWN#1477。',
      '机器人在线且排行榜专用会话有效时，每天 GMT+8 01:00 保存全球前 1000 名；服务离线或会话失效会导致快照缺失，会话失效时需主人重新登录恢复授权。',
      '二维码是本插件的登录入口，非官方扫码授权。仅支持账号密码登录；服务器不保存账号密码，二维码请勿转发。',
    ].join('\n'));
  }
  async login() {
    if (this.e.isGroup || this.e.group_id) return this.reply('请私聊机器人发送 #piu 登录，领取自己的登录二维码。');
    try {
      const ticket = await (await service()).login(identity(this.e));
      const png = await QRCode.toBuffer(ticket.url, {width: 600, margin: 3, errorCorrectionLevel: 'M'});
      const minutes = Math.ceil((ticket.expiresAt - Date.now()) / 60000);
      await this.reply(`请用手机扫码或打开下方链接，在独立窗口内完成 PIU 官网登录，再点击“完成并绑定”。有效期约 ${minutes} 分钟。\n服务器将保存登录会话用于读取成绩；账号密码不会保存。二维码请勿转发。`);
      return this.reply([image(png), ticket.url]);
    } catch (error) { return this.reply(publicError(error)); }
  }
  async best50() {
    const selector = String(this.e.msg ?? this.e.raw_message ?? '').replace(/^#?piu\s*(?:b50|best50)/i, '').trim();
    if (/@|\[CQ:at(?:,|\])/.test(selector) || this.e.at && String(this.e.at) !== String(this.e.self_id ?? this.e.bot?.uin)) return this.reply('请填写自己账号的完整 名称#标签，例如 #piu b50 ZANTING#9403。');
    try { return await this.reply(image(await (await service()).best50(identity(this.e), selector))); }
    catch (error) { return this.reply(publicError(error)); }
  }
  async gameIds() {
    if (this.e.isGroup || this.e.group_id) return this.reply('请私聊机器人发送 #piu list，查看自己账号绑定的全部 名称#标签。');
    try {
      const ids = await (await service()).gameIds(identity(this.e));
      if (!ids.length) return this.reply('此账号尚未绑定 GAME ID。');
      const rows = ids.map((item, index) => {
        const name = (item.playerName || `${item.gameId || 'GAME ID'}${item.tag || ''}`).replace(/\s*#\s*/, '#');
        const score = Number(item.pumbility);
        return `${index + 1}. ${name}${item.selected ? '（官网当前）' : ''} · Pumbility ${Number.isFinite(score) ? score.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '暂无'} · ${item.recordCount ?? 0} 条成绩`;
      });
      return this.reply(`自己的 PIU 档案\n${rows.join('\n')}\n使用 #piu b50 名称#标签 指定档案；#piu b50 默认生成首个档案。`);
    } catch (error) { return this.reply(publicError(error)); }
  }
  async unbind() {
    try {
      await (await service()).unbind(identity(this.e));
      return this.reply('已删除本机器人保存的 PIU 登录会话和图片缓存。');
    } catch (error) { return this.reply(publicError(error)); }
  }
  async rankLogin() {
    if (!this.e.isMaster) return this.reply('只有机器人主人可以授权每日排行榜采集会话。');
    if (this.e.isGroup || this.e.group_id) return this.reply('请机器人主人私聊发送 #piu ranklogin，授权每日排行榜采集会话。');
    try {
      const ranking = await rankingService();
      const ticket = await (await service()).login(identity(this.e), {onBoundSession: state => ranking.setSession(state)});
      const png = await QRCode.toBuffer(ticket.url, {width: 600, margin: 3, errorCorrectionLevel: 'M'});
      const minutes = Math.ceil((ticket.expiresAt - Date.now()) / 60000);
      await this.reply(`此登录用于机器人每日排行榜采集。完成登录并点击“完成并绑定”后，服务器会加密保存专用会话，并按配置保活，用于 GMT+8 每天 01:00 抓取全球前 1000 名；账号密码不会保存。\n请扫码或打开链接，有效期约 ${minutes} 分钟，二维码请勿转发。`);
      return this.reply([image(png), ticket.url]);
    } catch (error) { return this.reply(publicError(error)); }
  }
  async rank() {
    const args = message(this.e).replace(/^#?piu\s*rank\b/i, '').trim().split(/\s+/).filter(Boolean);
    if (args.length !== 0 && (args.length !== 2 || args.some(value => !/^\d{8}$/.test(value)))) {
      return this.reply('用法：#piu rank，或 #piu rank 20261103 20261003（两个日期均为 YYYYMMDD）。');
    }
    try { return await this.reply(image(await (await rankingService()).rank(identity(this.e), ...args))); }
    catch (error) { return this.reply(publicError(error)); }
  }
  async follow() {
    const args = message(this.e).replace(/^#?piu\s*follow\b/i, '').trim();
    try {
      const ranking = await rankingService();
      if (!args) {
        const follows = await ranking.listFollows(identity(this.e));
        return this.reply(`${follows.length ? `自己的 PIU 关注列表（${follows.length} 人）\n${followNames(follows)}` : '自己的 PIU 关注列表为空。'}\n用 #piu follow SHAWN#1477 YINYBEST#3231 批量添加。`);
      }
      const {added, follows} = await ranking.follow(identity(this.e), args);
      return this.reply(`${added.length ? `已关注\n${followNames(added)}` : '这些档案已在关注列表中。'}\n当前共关注 ${follows.length} 人；使用 #piu rank 生成比较图。`);
    } catch (error) { return this.reply(publicError(error)); }
  }
  async unfollow() {
    const args = message(this.e).replace(/^#?piu\s*unfollow\b/i, '').trim();
    try {
      const ranking = await rankingService();
      if (!args) {
        const follows = await ranking.listFollows(identity(this.e));
        return this.reply(`${follows.length ? `自己的 PIU 关注列表（${follows.length} 人）\n${followNames(follows)}` : '自己的 PIU 关注列表为空。'}\n用 #piu unfollow SHAWN#1477 YINYBEST#3231 批量移除。`);
      }
      const {removed, follows} = await ranking.unfollow(identity(this.e), args);
      return this.reply(`${removed.length ? `已取消关注\n${followNames(removed)}` : '这些档案不在自己的关注列表中。'}\n当前共关注 ${follows.length} 人。`);
    } catch (error) { return this.reply(publicError(error)); }
  }
}
