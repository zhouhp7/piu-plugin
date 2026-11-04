import { PUMBILITY_URL, RECENT_URL, PLAY_DATA_URL, TITLE_URL, PIU_ORIGIN } from './browser.js';
import { parsePumbility, parseRecent, parseGameIds, resolveGameId } from './parser.js';
import { PiuError } from './errors.js';
import { getJacketCache } from './jacket-cache.js';
import { parsePlayData } from './play-data.js';
import { parseTitleProgress } from './title-progress.js';

export function piuOnlyState(state) {
  return {cookies: (state.cookies ?? []).filter(cookie => ['piugame.com', 'www.piugame.com'].includes(cookie.domain.replace(/^\./, ''))),
    origins: (state.origins ?? []).filter(item => item.origin === PIU_ORIGIN || item.origin === 'https://piugame.com')};
}

/** Use Chromium's verified TLS session; the site's incomplete chain fails Node's separate TLS stack. */
export async function fetchOfficialJacket(page, value) {
  const url = new URL(value);
  if (url.origin !== PIU_ORIGIN || url.username || url.password) return null;
  const encoded = await page.evaluate(async source => {
    if (location.origin !== new URL(source).origin) return null;
    const response = await fetch(source, {credentials: 'same-origin', redirect: 'error',
      signal: AbortSignal.timeout(20000), cache: 'force-cache'});
    const limit = 4000000;
    if (!response.ok || !/^image\/(png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    let binary = '';
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i += 32768) binary += String.fromCharCode(...chunk.subarray(i, i + 32768));
    }
    return btoa(binary);
  }, url.href);
  return encoded ? Buffer.from(encoded, 'base64') : null;
}
export async function readProfile(page, {paginate = true} = {}) {
  let response;
  try { response = await page.goto(PUMBILITY_URL, {waitUntil: 'domcontentloaded'}); }
  catch { throw new PiuError('NETWORK', '无法访问 PIU 官网，请稍后重试。'); }
  if (!page.url().startsWith(PUMBILITY_URL)) throw new PiuError('AUTH_REQUIRED', '尚未登录成功，请在登录窗口完成登录后重试。');
  if (!response?.ok()) throw new PiuError('NETWORK', 'PIU 官网返回异常状态，请稍后重试。');
  const profile = parsePumbility(await page.content());
  if (paginate && profile.records.length < 50 && profile.lastPage > 1) {
    const seen = new Set(profile.records.map(r => `${r.title}\0${r.mode}\0${r.level}`));
    for (let n = 2; n <= Math.min(profile.lastPage, 20) && profile.records.length < 50; n++) {
      const next = await page.goto(`${PUMBILITY_URL}?page=${n}`, {waitUntil: 'domcontentloaded'});
      if (!next?.ok() || !page.url().startsWith(PUMBILITY_URL)) throw new PiuError('AUTH_REQUIRED', '成绩读取中断，请重新登录后重试。');
      const chunk = parsePumbility(await page.content(), {offset: profile.records.length});
      let added = 0;
      for (const r of chunk.records) {
        const id = `${r.title}\0${r.mode}\0${r.level}`;
        if (!seen.has(id)) { seen.add(id); profile.records.push(r); added++; }
      }
      if (!added) throw new PiuError('PAGE_CHANGED', '官网分页未能继续读取，已停止生成以避免缺少成绩。');
    }
  }
  profile.records = profile.records.slice(0, 50);
  return profile;
}

/** Login metadata identifies every profile belonging to this official account. */
export async function readAccount(page, {paginate = false} = {}) {
  const profile = await readProfile(page, {paginate});
  let gameIds = parseGameIds(await page.content());
  if (!gameIds.length) {
    const response = await page.goto(`${PIU_ORIGIN}/my_page/game_id_information.php`, {waitUntil: 'domcontentloaded'});
    if (!response?.ok() || !page.url().startsWith(`${PIU_ORIGIN}/my_page/`)) throw new PiuError('AUTH_REQUIRED', '未能读取账号档案，请重新登录。');
    gameIds = parseGameIds(await page.content());
  }
  if (!gameIds.length) throw new PiuError('PAGE_CHANGED', '未能识别账号的档案列表，未保存此次绑定。');
  return {...profile, gameIds};
}

async function switchGameId(page, target) {
  if (!/^\d{1,16}$/.test(target.id)) throw new PiuError('PAGE_CHANGED', '无法识别官网卡片标识。');
  const ok = await page.evaluate(async id => {
    const response = await fetch('/ajax/sub_profile.php', {method: 'POST', credentials: 'same-origin',
      redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
      body: new URLSearchParams({no: id}).toString()});
    return response.ok;
  }, target.id);
  if (!ok) throw new PiuError('GAME_ID_SWITCH_FAILED', '官网未能切换 Game ID，请稍后重试。');
  const profile = await readProfile(page);
  const active = parseGameIds(await page.content()).find(item => item.selected);
  const canonical = name => name.replace(/\s*#\s*/g, '#').trim().toUpperCase();
  if (active?.id !== target.id || canonical(profile.playerName) !== canonical(target.playerName)) {
    throw new PiuError('GAME_ID_SWITCH_FAILED', '切换后的 Game ID 与请求不一致，已停止出图。');
  }
  return profile;
}

async function withAccount(browserManager, state, action) {
  const context = await browserManager.context(state);
  try {
    if (typeof context.route === 'function') {
      // These contexts read server-rendered data, not an interactive login UI.
      // Avoid competing automatic avatar/jacket downloads; explicit fetches still run.
      await context.route('**/*', route => ['image', 'font', 'stylesheet', 'media'].includes(route.request().resourceType())
        ? route.abort('blockedbyclient') : route.fallback());
    }
    const page = await context.newPage();
    const initialProfile = await readProfile(page);
    let gameIds = parseGameIds(await page.content());
    if (!gameIds.length) {
      await page.goto(`${PIU_ORIGIN}/my_page/game_id_information.php`, {waitUntil: 'domcontentloaded'});
      gameIds = parseGameIds(await page.content());
      await readProfile(page);
    }
    const selected = gameIds.filter(item => item.selected);
    if (gameIds.length && selected.length !== 1) {
      throw new PiuError('PAGE_CHANGED', '无法唯一确认当前 Game ID，已停止切换以保护原始选择。');
    }
    const original = selected[0];
    let switchAttempted = false;
    const selectGameId = async target => {
      // A POST may change the server even when the following navigation fails.
      switchAttempted = true;
      return switchGameId(page, target);
    };
    let result;
    try { result = await action({page, initialProfile, gameIds, selectGameId}); }
    finally {
      if (original && switchAttempted) await switchGameId(page, original);
    }
    return {...result, state: piuOnlyState(await context.storageState())};
  } finally { await context.close(); }
}

export async function fetchGameIds(browserManager, state) {
  return withAccount(browserManager, state, async ({page, initialProfile, gameIds, selectGameId}) => {
    if (!gameIds.length) throw new PiuError('PAGE_CHANGED', '未能读取账号的 Game ID 列表，请检查官网页面。');
    const summaries = [];
    for (const item of gameIds) {
      const current = parseGameIds(await page.content()).find(card => card.selected);
      const profile = current?.id === item.id ? (item.selected ? initialProfile : await readProfile(page)) : await selectGameId(item);
      summaries.push({...item, pumbility: profile.pumbility, recordCount: profile.records.length});
    }
    return {gameIds: summaries};
  });
}

export async function fetchProfile(browserManager, state, {gameId = ''} = {}) {
  return withAccount(browserManager, state, async ({page, initialProfile, gameIds, selectGameId}) => {
    const target = resolveGameId(gameIds, gameId);
    const profile = target && !target.selected ? await selectGameId(target) : initialProfile;
    if (target) { profile.gameId = target.gameId; profile.gameIdTag = target.tag; }
    let response;
    try { response = await page.goto(TITLE_URL, {waitUntil: 'domcontentloaded'}); }
    catch { throw new PiuError('NETWORK', '无法访问 PIU Title 页面，请稍后重试。'); }
    const location = new URL(page.url());
    if (location.origin !== PIU_ORIGIN || location.pathname !== '/my_page/title.php') throw new PiuError('AUTH_REQUIRED', 'Title 页面登录已失效，请重新扫码或导入该账号 Cookie。');
    if (!response?.ok()) throw new PiuError('NETWORK', 'PIU Title 页面返回异常状态，请稍后重试。');
    const titles = parseTitleProgress(await page.content());
    if (titles.playerName !== profile.playerName) throw new PiuError('GAME_ID_SWITCH_FAILED', 'Title 页面的档案与 B50 不一致，已停止生成。');
    profile.titleProgress = titles;
    const images = await profileJackets(browserManager, page, profile);
    return {profile, images, gameIds};
  });
}

export async function fetchRecent(browserManager, state, {gameId = ''} = {}) {
  return withAccount(browserManager, state, async ({page, initialProfile, gameIds, selectGameId}) => {
    const target = resolveGameId(gameIds, gameId);
    const selected = target && !target.selected ? await selectGameId(target) : initialProfile;
    let response;
    try { response = await page.goto(RECENT_URL, {waitUntil: 'domcontentloaded'}); }
    catch { throw new PiuError('NETWORK', '无法访问 PIU 最近游玩页面，请稍后重试。'); }
    if (!page.url().startsWith(RECENT_URL)) throw new PiuError('AUTH_REQUIRED', '登录已失效，请私聊发送 #piu login。');
    if (!response?.ok()) throw new PiuError('NETWORK', 'PIU 最近游玩页面返回异常状态，请稍后重试。');
    const profile = parseRecent(await page.content());
    if (profile.playerName !== selected.playerName) {
      throw new PiuError('GAME_ID_SWITCH_FAILED', '最近游玩的 GAME ID 与请求不一致，已停止出图。');
    }
    profile.pumbility = selected.pumbility;
    if (target) { profile.gameId = target.gameId; profile.gameIdTag = target.tag; }
    const images = await profileJackets(browserManager, page, profile);
    return {profile, images, gameIds};
  });
}

export async function fetchPlayData(browserManager, state, {gameId = ''} = {}) {
  return withAccount(browserManager, state, async ({page, initialProfile, gameIds, selectGameId}) => {
    const target = resolveGameId(gameIds, gameId);
    const selected = target && !target.selected ? await selectGameId(target) : initialProfile;
    let response;
    try { response = await page.goto(PLAY_DATA_URL, {waitUntil: 'domcontentloaded'}); }
    catch { throw new PiuError('NETWORK', '无法访问 PIU Play Data 页面，请稍后重试。'); }
    if (!page.url().startsWith(PLAY_DATA_URL)) throw new PiuError('AUTH_REQUIRED', '登录已失效，请私聊发送 #piu login。');
    if (!response?.ok()) throw new PiuError('NETWORK', 'PIU Play Data 页面返回异常状态，请稍后重试。');
    const profile = parsePlayData(await page.content());
    if (profile.playerName !== selected.playerName) throw new PiuError('GAME_ID_SWITCH_FAILED', 'Play Data 的 GAME ID 与请求不一致，已停止出图。');
    profile.pumbility = selected.pumbility;
    if (target) { profile.gameId = target.gameId; profile.gameIdTag = target.tag; }
    return {profile, images: new Map(), gameIds};
  });
}

async function profileJackets(browserManager, page, profile) {
  const jacketCache = getJacketCache(browserManager);
  const images = new Map();
  // Deduplicate downloads, never the actual recent-play records.
  const urls = [...new Set(profile.records.map(record => record.jacket).filter(Boolean))];
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(4, urls.length)}, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const data = await jacketCache.getOrLoad(url, source => fetchOfficialJacket(page, source));
          if (data) { images.set(url, data); break; }
        } catch { /* One bounded retry for missing art; scores remain unchanged. */ }
      }
    }
  }));
  return images;
}
