import {load} from 'cheerio';
import {PIU_ORIGIN} from './browser.js';
import {fetchOfficialJacket} from './client.js';
import {canonicalJacketUrl, getJacketCache} from './jacket-cache.js';
import {PiuError} from './errors.js';

export const JACKET_CATALOGUE_URL = `${PIU_ORIGIN}/leaderboard/over_ranking.php`;

export function extractJacketUrls(html, baseUrl = JACKET_CATALOGUE_URL) {
  const $ = load(html);
  const urls = new Map();
  const add = raw => {
    if (!raw) return;
    let value;
    try { value = new URL(raw, baseUrl).href; } catch { return; }
    const key = canonicalJacketUrl(value);
    if (key && !urls.has(key)) urls.set(key, canonicalJacketUrl(value, {keepQuery: true}));
  };
  $('img, [style]').each((_, element) => {
    const item = $(element);
    for (const attr of ['src', 'data-src', 'data-original']) add(item.attr(attr));
    const regex = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi;
    for (const match of (item.attr('style') ?? '').matchAll(regex)) add(match[1] ?? match[2] ?? match[3]);
  });
  return [...urls.values()];
}

export function parseJacketCataloguePage(html, {page = 1} = {}) {
  const $ = load(html);
  const urls = extractJacketUrls(html);
  if (!urls.length && $('form#login_fs, input[name="mb_password"]').length) {
    throw new PiuError('RANK_AUTH', '曲绘预存需要有效的官网会话，请主人先完成 #piu ranklogin。');
  }
  if (!urls.length) throw new PiuError('JACKET_PAGE', '未识别到官网曲绘目录，未继续预存。');
  const pages = new Set();
  $('.board_paging a, .board_paging button').each((_, element) => {
    const item = $(element);
    const source = `${item.attr('href') ?? ''} ${item.attr('onclick') ?? ''}`;
    for (const match of source.matchAll(/(?:[?&]|\b)page=(\d+)/g)) {
      const candidate = Number(match[1]);
      if (candidate > page && candidate <= 1000) pages.add(candidate);
    }
  });
  return {urls, nextPage: pages.has(page + 1) ? page + 1 : null};
}

/** Bounded, authenticated catalogue read. No game/profile selection is changed. */
export async function prefetchJackets(browserManager, state, {cacheDirectory, maxPages = 3, maxImages = 120} = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 || !Number.isInteger(maxImages) || maxImages < 1 || maxImages > 1000) {
    throw new TypeError('Jacket prefetch limits are invalid.');
  }
  const cache = getJacketCache(browserManager, {directory: cacheDirectory});
  const context = await browserManager.context(state);
  const result = {pages: 0, discovered: 0, downloaded: 0, cached: 0, failed: 0};
  try {
    if (typeof context.route === 'function') {
      await context.route('**/*', route => ['image', 'font', 'stylesheet', 'media'].includes(route.request().resourceType())
        ? route.abort('blockedbyclient') : route.fallback());
    }
    const page = await context.newPage();
    const sources = new Map();
    let current = 1;
    while (result.pages < maxPages && sources.size < maxImages) {
      let response;
      try { response = await page.goto(`${JACKET_CATALOGUE_URL}?page=${current}`, {waitUntil: 'domcontentloaded'}); }
      catch { throw new PiuError('JACKET_NETWORK', '无法连接官网曲绘目录。'); }
      const location = new URL(page.url());
      if (location.origin !== PIU_ORIGIN || location.pathname !== '/leaderboard/over_ranking.php') {
        throw new PiuError('RANK_AUTH', '曲绘预存会话已失效，请主人重新完成 #piu ranklogin。');
      }
      if (!response?.ok()) throw new PiuError('JACKET_NETWORK', '官网曲绘目录返回异常状态。');
      const parsed = parseJacketCataloguePage(await page.content(), {page: current});
      result.pages++;
      for (const url of parsed.urls) {
        const key = canonicalJacketUrl(url);
        if (!sources.has(key) && sources.size < maxImages) sources.set(key, url);
      }
      if (!parsed.nextPage) break;
      current = parsed.nextPage;
    }
    result.discovered = sources.size;
    const urls = [...sources.values()];
    let cursor = 0;
    await Promise.all(Array.from({length: Math.min(4, urls.length)}, async () => {
      while (cursor < urls.length) {
        const url = urls[cursor++];
        let downloaded = false;
        let bytes = null;
        for (let attempt = 0; attempt < 2 && !bytes; attempt++) {
          try { bytes = await cache.getOrLoad(url, source => { downloaded = true; return fetchOfficialJacket(page, source); }); }
          catch { /* Retry a missing immutable asset once, without expanding the bounds. */ }
        }
        if (bytes) result[downloaded ? 'downloaded' : 'cached']++;
        else result.failed++;
      }
    }));
    return {...result, stats: await cache.stats()};
  } finally { await context.close(); }
}
