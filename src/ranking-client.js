import {BrowserManager, PIU_ORIGIN} from './browser.js';
import {parseRankingPage, auditRanking} from './ranking-parser.js';
import {PiuError} from './errors.js';

export const RANKING_URL = `${PIU_ORIGIN}/leaderboard/pumbility_ranking.php`;
const AUTH_HOSTS = new Set(['piugame.com', 'www.piugame.com', 'api.am-pass.net', 'am-pass.net', 'www.am-pass.net']);

/** A separate, explicitly authorized session for the bot's shared daily collector. */
export function rankingSessionState(state) {
  return {
    cookies: (state?.cookies ?? []).filter(item => AUTH_HOSTS.has(item.domain?.replace(/^\./, ''))),
    origins: (state?.origins ?? []).filter(item => {
      try { const url = new URL(item.origin); return url.protocol === 'https:' && AUTH_HOSTS.has(url.hostname); }
      catch { return false; }
    }),
  };
}

export class RankingReader {
  constructor(config = {}, {browser} = {}) { this.browser = browser ?? new BrowserManager(config); }

  async fetch(state) {
    const context = await this.browser.context(state);
    const startedAt = new Date().toISOString();
    try {
      await context.route('**/*', route => ['image', 'font', 'stylesheet', 'media'].includes(route.request().resourceType())
        ? route.abort('blockedbyclient') : route.fallback());
      const page = await context.newPage();
      const entries = [];
      const keys = new Set();
      const pages = new Set();
      let number = 1;
      let sourceUpdatedAt = null;
      while (entries.length < 1000) {
        if (pages.has(number) || pages.size >= 100 || number < 1 || number > 1000) {
          throw new PiuError('RANK_INCOMPLETE', '排行榜分页异常，未保存不完整快照。');
        }
        pages.add(number);
        let response;
        try { response = await page.goto(`${RANKING_URL}?t=&page=${number}`, {waitUntil: 'domcontentloaded'}); }
        catch { throw new PiuError('RANK_NETWORK', '无法连接 PIU 排行榜，请稍后重试。'); }
        const location = new URL(page.url());
        if (location.origin !== PIU_ORIGIN || location.pathname !== '/leaderboard/pumbility_ranking.php') {
          throw new PiuError('RANK_AUTH', '排行榜采集会话已失效，请机器人主人私聊 #piu ranklogin 重新授权。');
        }
        if (!response?.ok()) throw new PiuError('RANK_NETWORK', '官网排行榜返回异常状态，未保存快照。');
        const result = parseRankingPage(await page.content(), {page: number});
        sourceUpdatedAt ??= result.sourceUpdatedAt;
        for (const entry of result.entries) {
          if (keys.has(entry.playerKey)) throw new PiuError('RANK_INCOMPLETE', '排行榜跨页出现重复档案，已停止入库。');
          keys.add(entry.playerKey); entries.push(entry);
        }
        if (entries.length >= 1000) break;
        if (!result.nextPage) throw new PiuError('RANK_INCOMPLETE', `只读取到 ${entries.length} 条，未保存不完整的前 1000 名快照。`);
        number = result.nextPage;
      }
      if (entries.length !== 1000 || entries[0]?.worldRank !== 1 || entries.some((row, index) => index > 0 && row.worldRank < entries[index - 1].worldRank)) {
        throw new PiuError('RANK_INCOMPLETE', '全球前 1000 名校验失败，未保存快照。');
      }
      return {entries, audit: auditRanking(entries), sourceUpdatedAt, startedAt,
        capturedAt: new Date().toISOString(), state: rankingSessionState(await context.storageState())};
    } finally { await context.close(); }
  }

  async keepAlive(state) {
    const context = await this.browser.context(state);
    try {
      const page = await context.newPage();
      // Establish an official same-origin document, then issue a body-free session request.
      await page.goto(`${PIU_ORIGIN}/robots.txt`, {waitUntil: 'domcontentloaded'});
      const result = await page.evaluate(async url => {
        const response = await fetch(url, {method: 'HEAD', credentials: 'same-origin', redirect: 'follow',
          signal: AbortSignal.timeout(15000)});
        return {ok: response.ok, url: response.url};
      }, RANKING_URL);
      const target = new URL(result.url);
      if (!result.ok || target.origin !== PIU_ORIGIN || target.pathname !== '/leaderboard/pumbility_ranking.php') {
        throw new PiuError('RANK_AUTH', '排行榜采集会话已失效，请机器人主人私聊 #piu ranklogin 重新授权。');
      }
      return {state: rankingSessionState(await context.storageState())};
    } finally { await context.close(); }
  }

  async close() { await this.browser.close(); }
}
