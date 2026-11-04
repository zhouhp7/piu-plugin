import plugin from '../../../lib/plugins/plugin.js';
import { renderLoginQr } from '../src/login-qr.js';
import { createService } from '../src/service.js';
import { createRankingService } from '../src/ranking-service.js';
import { loadConfig, loadRankingConfig } from '../src/config.js';
import { publicError } from '../src/errors.js';
import { renderHelp } from '../src/help-image.js';

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
export function followIdentity(e) {
  const groupId = e.group_id ?? e.group?.group_id;
  if (groupId !== undefined && groupId !== null) {
    const botId = e.self_id ?? e.bot?.uin;
    if (botId === undefined) throw new Error('Missing bot identity');
    return JSON.stringify([String(e.bot?.adapter?.id ?? e.adapter?.id ?? 'default'), String(botId), 'group', String(groupId)]);
  }
  if (e.isGroup) throw new Error('Missing group identity');
  return identity(e);
}
const image = buffer => globalThis.segment?.image(buffer) ?? {type: 'image', file: buffer};
const message = event => String(event.msg ?? event.raw_message ?? '');
const followNames = entries => entries.map(entry => `${entry.gameId}${entry.tag}`).join('\n');
const followLabel = event => event.isGroup || event.group_id != null || event.group?.group_id != null ? '本群' : '自己';
const profileName = profile => (profile.playerName || `${profile.gameId || 'GAME ID'}${profile.tag || ''}`).replace(/\s*#\s*/, '#');
function profileList(ids, heading = '自己的 PIU 档案（本地缓存）') {
  if (!ids.length) return `${heading}\n本地尚无档案，请先 #piu login 绑定账号；已绑定时可用 #piu refresh 更新档案缓存。`;
  const rows = ids.map((item, index) => {
    const score = item.pumbility == null ? NaN : Number(item.pumbility);
    return `${item.index ?? index + 1}. ${profileName(item)}${item.isDefault ? '【默认】' : ''}${item.account ? `（账号 ${item.account}）` : ''}${item.authExpired ? ' · 登录已失效，请重新绑定该账号' : ''} · Pumbility ${Number.isFinite(score) ? score.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—'} · ${Number.isInteger(item.recordCount) ? item.recordCount : '—'} 条成绩`;
  });
  return `${heading}\n${rows.join('\n')}\n#piu default 序号 或 #piu list 序号 设置默认档案。b50 / recent / data 可用序号、唯一名称、#标签或完整 名称#标签；不填时使用默认档案。\n列表只读取本地缓存；#piu refresh 从官网更新本地档案缓存。`;
}

export class PiuBest50 extends plugin {
  constructor() {
    super({name: 'PIU Best50', dsc: 'PIU Pumbility 成绩图', event: 'message', priority: 5000,
      rule: [{reg: '^#?(?:piu|PIU)\\s*(?:帮助|help)$', fnc: 'help'},
        {reg: '^#?(?:piu|PIU)\\s*(?:login|LOGIN|登录|登陆|绑定)(?:\\s+[\\s\\S]*)?$', fnc: 'login'},
        {reg: '^#?(?:piu|PIU)\\s*(?:b50|B50|best50|Best50)(?:\\s+[^@\\r\\n]{1,160})?\\s*$', fnc: 'best50'},
        {reg: '^#?(?:piu|PIU)\\s*(?:recent|RECENT)(?:\\s+[^@\\r\\n]{1,160})?\\s*$', fnc: 'recent'},
        {reg: '^#?(?:piu|PIU)\\s*(?:data|DATA)(?:\\s+[^@\\r\\n]{1,160})?\\s*$', fnc: 'playData'},
        {reg: '^#?(?:piu|PIU)\\s*(?:list|LIST|账号|游戏ID|游戏id|ids|IDS)(?:\\s+[^@\\r\\n]{1,160})?\\s*$', fnc: 'gameIds'},
        {reg: '^#?(?:piu|PIU)\\s*(?:default|DEFAULT)(?:\\s+[^@\\r\\n]{1,160})?\\s*$', fnc: 'defaultProfile'},
        {reg: '^#?(?:piu|PIU)\\s*(?:refresh|REFRESH)\\s*$', fnc: 'refresh'},
        {reg: '^#?(?:piu|PIU)\\s*(?:ranklogin|RANKLOGIN)(?:\\s+[\\s\\S]*)?$', fnc: 'rankLogin', permission: 'master'},
        {reg: '^#?(?:piu|PIU)\\s*(?:rank|RANK)(?:\\s+[^\\r\\n]{1,80})?\\s*$', fnc: 'rank'},
        {reg: '^#?(?:piu|PIU)\\s*(?:follow|FOLLOW)(?:\\s+[^\\r\\n]{1,1000})?\\s*$', fnc: 'follow'},
        {reg: '^#?(?:piu|PIU)\\s*(?:unfollow|UNFOLLOW)(?:\\s+[^\\r\\n]{1,1000})?\\s*$', fnc: 'unfollow'},
        {reg: '^#?(?:piu|PIU)\\s*(?:logout|LOGOUT|解绑|退出)$', fnc: 'logout'}]});
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
    try { return await this.reply(image(await renderHelp())); }
    catch (error) { return this.reply(publicError(error)); }
  }
  async login() {
    // Never quote the source message: it may contain a live login credential.
    if (this.e.isGroup || this.e.group_id) return this.reply('登录仅限私聊。请私聊发送 #piu login 扫码，或 #piu login sid=会话值 导入 Cookie；请勿在群聊发送登录凭证。', false);
    const input = message(this.e).replace(/^#?piu\s*(?:login\b|登录|登陆|绑定)/i, '').trim();
    if (/^(?:help|cookie)$/i.test(input)) return this.reply('在自己的浏览器登录 https://www.piugame.com，打开个人 Pumbility 页面。\n开发者工具 Application → Cookies 中找到 sid，复制 Value，然后私聊发送：\n#piu login sid=复制的值\n也可在 Network 中复制 pumbility.php 请求的完整 Cookie 值，或粘贴 PIU Cookie JSON 文本。不同账号会追加，同一账号会更新；#piu list 查看全部档案，#piu logout 删除全部个人绑定。Cookie 相当于登录凭证，请只发送给可信机器人。', false);
    try {
      const accountService = await service();
      if (input) {
        await accountService.importCookies(identity(this.e), input);
        return this.reply('Cookie 登录验证成功，已加密保存并绑定。不同账号会追加，同一账号会更新会话。#piu list 查看全部账号档案；#piu logout 删除全部个人绑定。', false);
      }
      const ticket = await accountService.login(identity(this.e));
      const picture = await renderLoginQr(ticket.url);
      const minutes = Math.ceil((ticket.expiresAt - Date.now()) / 60000);
      await this.reply(`请扫码或打开链接，在独立窗口完成 PIU 官网登录，再点击“完成并绑定”。有效期约 ${minutes} 分钟。\n不同账号会追加，同一账号重新登录会更新会话。会话加密保存，不保存密码。二维码请勿转发。\n也可私聊 #piu login sid=会话值 直接导入；#piu login help 查看获取方法。`, false);
      return this.reply([image(picture), ticket.url], false);
    } catch (error) { return this.reply(publicError(error), false); }
  }
  async best50() {
    const selector = String(this.e.msg ?? this.e.raw_message ?? '').replace(/^#?piu\s*(?:b50|best50)/i, '').trim();
    if (/@|\[CQ:at(?:,|\])/.test(selector) || this.e.at && String(this.e.at) !== String(this.e.self_id ?? this.e.bot?.uin)) return this.reply('请从 #piu list 选择本人档案，可填写序号、唯一名称、#标签或完整 名称#标签。');
    try { return await this.reply(image(await (await service()).best50(identity(this.e), selector))); }
    catch (error) { return this.reply(publicError(error)); }
  }
  async recent() {
    const selector = message(this.e).replace(/^#?piu\s*recent/i, '').trim();
    if (/@|\[CQ:at(?:,|\])/.test(selector) || this.e.at && String(this.e.at) !== String(this.e.self_id ?? this.e.bot?.uin)) return this.reply('请从 #piu list 选择本人档案，可填写序号、唯一名称、#标签或完整 名称#标签。');
    try { return await this.reply(image(await (await service()).recent(identity(this.e), selector))); }
    catch (error) { return this.reply(publicError(error)); }
  }
  async playData() {
    const selector = message(this.e).replace(/^#?piu\s*data/i, '').trim();
    if (/@|\[CQ:at(?:,|\])/.test(selector) || this.e.at && String(this.e.at) !== String(this.e.self_id ?? this.e.bot?.uin)) return this.reply('请从 #piu list 选择本人档案，可填写序号、唯一名称、#标签或完整 名称#标签。');
    try { return await this.reply(image(await (await service()).data(identity(this.e), selector))); }
    catch (error) { return this.reply(publicError(error)); }
  }
  async gameIds() {
    if (this.e.isGroup || this.e.group_id) return this.reply('请私聊机器人发送 #piu list，查看本地档案列表或设置默认档案。');
    const selector = message(this.e).replace(/^#?piu\s*(?:list\b|ids\b|账号|游戏ID)/i, '').trim();
    if (selector) return this.chooseDefault(selector);
    try {
      const ids = await (await service()).gameIds(identity(this.e));
      return this.reply(profileList(ids));
    } catch (error) { return this.reply(publicError(error)); }
  }
  async chooseDefault(selector) {
    if (!/^[1-9]\d*$/.test(selector)) return this.reply('用法：#piu default 序号，或 #piu list 序号；请先用 #piu list 查看档案序号。');
    try {
      const selected = await (await service()).setDefault(identity(this.e), selector);
      return this.reply(`已将 ${profileName(selected)}（序号 ${selected.index ?? selector}）设为默认档案。之后 #piu b50、#piu recent、#piu data 不填参数时使用此档案。`);
    } catch (error) { return this.reply(publicError(error)); }
  }
  async defaultProfile() {
    if (this.e.isGroup || this.e.group_id) return this.reply('请私聊机器人用 #piu default 序号 设置自己的默认档案。');
    return this.chooseDefault(message(this.e).replace(/^#?piu\s*default\b/i, '').trim());
  }
  async refresh() {
    if (this.e.isGroup || this.e.group_id) return this.reply('请私聊机器人发送 #piu refresh，刷新自己的档案缓存。');
    try {
      const ids = await (await service()).refresh(identity(this.e));
      return this.reply(profileList(ids, 'PIU 档案缓存已刷新'));
    } catch (error) { return this.reply(publicError(error)); }
  }
  async logout() {
    try {
      await (await service()).unbind(identity(this.e));
      return this.reply('已删除本机器人保存的全部个人 PIU 账号会话和成绩图片缓存。');
    } catch (error) { return this.reply(publicError(error)); }
  }
  async rankLogin() {
    // Every reply avoids quoting a message that may contain a live credential.
    if (!this.e.isMaster) return this.reply('只有机器人主人可以授权每日排行榜采集会话。', false);
    if (this.e.isGroup || this.e.group_id) return this.reply('请机器人主人私聊发送 #piu ranklogin，授权每日排行榜采集会话。Cookie 请勿发到群聊。', false);
    const input = message(this.e).replace(/^#?piu\s*ranklogin\b/i, '').trim();
    if (/^(?:help|cookie)$/i.test(input)) return this.reply('先在自己的浏览器登录 https://www.piugame.com，在开发者工具 Application → Cookies 中复制 sid 的 Value，然后主人私聊发送：\n#piu ranklogin sid=复制的值\n也可粘贴官网请求的完整 Cookie 值或 PIU Cookie JSON 文本。验证完整前 1000 名后，加密保存排行榜专用会话，并按配置保活。无需反向代理，不会修改个人账号绑定。Cookie 相当于登录凭证，请只发送给可信机器人。\n不带参数的 #piu ranklogin 仍使用扫码登录。', false);
    try {
      const ranking = await rankingService();
      if (input) {
        const snapshot = await ranking.importCookies(input);
        return this.reply(`排行榜 Cookie 登录验证成功，已加密保存专用采集会话，并取得完整前 ${snapshot.count} 名快照。机器人在线且排行榜功能启用时，将按配置保活，每天 GMT+8 01:00 保存排行榜。个人账号绑定不受影响。`, false);
      }
      const ticket = await (await service()).login(identity(this.e), {onBoundSession: state => ranking.setSession(state)});
      const picture = await renderLoginQr(ticket.url);
      const minutes = Math.ceil((ticket.expiresAt - Date.now()) / 60000);
      await this.reply(`此登录用于机器人每日排行榜采集。完成登录并点击“完成并绑定”后，服务器会加密保存专用会话，并按配置保活，用于 GMT+8 每天 01:00 抓取全球前 1000 名；账号密码不会保存。\n请扫码或打开链接，有效期约 ${minutes} 分钟，二维码请勿转发。\n也可在自己设备登录后，私聊 #piu ranklogin sid=你的会话值 直接导入，无需反向代理；#piu ranklogin help 查看方法。`, false);
      return this.reply([image(picture), ticket.url], false);
    } catch (error) { return this.reply(publicError(error), false); }
  }
  async rank() {
    const args = message(this.e).replace(/^#?piu\s*rank\b/i, '').trim().split(/\s+/).filter(Boolean);
    if (args.length !== 0 && (args.length !== 2 || args.some(value => !/^\d{8}$/.test(value)))) {
      return this.reply('用法：#piu rank，或 #piu rank 20261103 20261003（两个日期均为 YYYYMMDD）。');
    }
    try { return await this.reply(image(await (await rankingService()).rank(followIdentity(this.e), ...args))); }
    catch (error) { return this.reply(publicError(error)); }
  }
  async follow() {
    const args = message(this.e).replace(/^#?piu\s*follow\b/i, '').trim();
    try {
      const ranking = await rankingService();
      const owner = followIdentity(this.e), label = followLabel(this.e);
      if (!args) {
        const follows = await ranking.listFollows(owner);
        return this.reply(`${follows.length ? `${label}的 PIU 关注列表（${follows.length} 人）\n${followNames(follows)}` : `${label}的 PIU 关注列表为空。`}\n用 #piu follow SHAWN#1477 YINYBEST#3231 批量添加。${label === '本群' ? '群内所有用户都可修改。' : ''}`);
      }
      const {added, follows} = await ranking.follow(owner, args);
      return this.reply(`${added.length ? `已关注\n${followNames(added)}` : '这些档案已在关注列表中。'}\n当前共关注 ${follows.length} 人；使用 #piu rank 生成比较图。`);
    } catch (error) { return this.reply(publicError(error)); }
  }
  async unfollow() {
    const args = message(this.e).replace(/^#?piu\s*unfollow\b/i, '').trim();
    try {
      const ranking = await rankingService();
      const owner = followIdentity(this.e), label = followLabel(this.e);
      if (!args) {
        const follows = await ranking.listFollows(owner);
        return this.reply(`${follows.length ? `${label}的 PIU 关注列表（${follows.length} 人）\n${followNames(follows)}` : `${label}的 PIU 关注列表为空。`}\n用 #piu unfollow SHAWN#1477 YINYBEST#3231 批量移除。${label === '本群' ? '群内所有用户都可修改。' : ''}`);
      }
      const {removed, follows} = await ranking.unfollow(owner, args);
      return this.reply(`${removed.length ? `已取消关注\n${followNames(removed)}` : `这些档案不在${label}的关注列表中。`}\n当前共关注 ${follows.length} 人。`);
    } catch (error) { return this.reply(publicError(error)); }
  }
}
