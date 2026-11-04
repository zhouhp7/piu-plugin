import path from 'node:path';
import { BrowserManager } from './browser.js';
import { fetchProfile, fetchRecent, fetchPlayData, fetchGameIds, readAccount, piuOnlyState } from './client.js';
import { Vault } from './vault.js';
import { createBridge } from './bridge.js';
import { renderBest50, renderRecent } from './render.js';
import { PiuError } from './errors.js';
import { normalizeGameIdSelector, resolveGameId } from './parser.js';
import { enrichProfileRanking } from './profile-ranking.js';
import { renderPlayData } from './play-data.js';
import { parseCookieState } from './cookies.js';
import { accountBindings, sameAccount, mergeAccount } from './account-bindings.js';

export async function createService(config, dependencies = {}) {
  const vault = dependencies.vault ?? new Vault({directory: path.join(config.dataDir, 'sessions'), key: config.key});
  const browser = dependencies.browser ?? new BrowserManager(config);
  const getProfile = dependencies.fetchProfile ?? fetchProfile;
  const getRecent = dependencies.fetchRecent ?? fetchRecent;
  const getGameIds = dependencies.fetchGameIds ?? fetchGameIds;
  const validateLogin = dependencies.readProfile ?? readAccount;
  const render = dependencies.renderBest50 ?? renderBest50;
  const renderRecentImage = dependencies.renderRecent ?? renderRecent;
  const imageTypes = {
    b50: {fetch: getProfile, render},
    recent: {fetch: getRecent, render: renderRecentImage},
    data: {fetch: dependencies.fetchPlayData ?? fetchPlayData, render: dependencies.renderPlayData ?? renderPlayData},
  };
  // Buckets keep cards isolated while bounding memory by both users and card images.
  const cache = new Map();
  const summaries = new Map();
  const pending = new Map();
  const mutations = new Map();
  const imports = new Map();
  const loginCallbacks = new Map();
  const imageTtl = Math.max(config.cacheMs, 10000);
  const summaryTtl = 120000;
  const beginMutation = key => mutations.set(key, (mutations.get(key) ?? 0) + 1);
  const endMutation = key => { const n = mutations.get(key) - 1; if (n) mutations.set(key, n); else mutations.delete(key); };
  const clearUser = key => { cache.delete(key); summaries.delete(key); };
  const trimCaches = () => {
    const users = new Set([...cache.keys(), ...summaries.keys()]);
    while (users.size > 100) { const oldest = users.values().next().value; clearUser(oldest); users.delete(oldest); }
    let images = [...cache.values()].reduce((total, bucket) => total + bucket.size, 0);
    for (const [userKey, bucket] of cache) {
      while (images > 100 && bucket.size) { bucket.delete(bucket.keys().next().value); images--; }
      if (!bucket.size) cache.delete(userKey);
    }
  };
  const rememberImage = (userKey, selector, picture) => {
    let bucket = cache.get(userKey);
    if (!bucket) { bucket = new Map(); cache.set(userKey, bucket); }
    bucket.set(selector, {picture, at: Date.now()});
    if (bucket.size > 16) bucket.delete(bucket.keys().next().value);
    trimCaches();
  };
  const loadBindings = async userKey => {
    const bindings = accountBindings(await vault.load(userKey));
    if (!bindings.accounts.length) throw new PiuError('AUTH_REQUIRED', '请先私聊发送 #piu login 扫码，或 #piu login sid=会话值 绑定自己的账号。');
    return bindings;
  };
  const expired = account => account.authExpired || Date.now() - account.savedAt > config.sessionMaxAgeMs;
  const requireActive = account => {
    if (expired(account)) throw new PiuError('AUTH_REQUIRED', '该档案所属账号的登录已失效，请重新扫码或导入该账号 Cookie；其他账号仍可使用。');
  };
  const bindAccount = async (userKey, state, profile) => {
    if (!profile?.gameIds?.length) throw new PiuError('PAGE_CHANGED', '未取得账号档案列表，未保存此次绑定。');
    const verified = piuOnlyState(state);
    const bindings = accountBindings(await vault.load(userKey));
    // An old-format session has no profile index yet. Discover it once so a
    // different login adds an account and a renewed login updates the old one.
    for (const account of bindings.accounts) {
      if (account.gameIds?.length || sameAccount(account, verified, profile.gameIds) || expired(account)) continue;
      try {
        const result = await getGameIds(browser, account.state);
        account.gameIds = result.gameIds;
        account.state = result.state;
      } catch (error) {
        if (!(error instanceof PiuError)) throw error;
        if (error.code === 'AUTH_REQUIRED') account.authExpired = true;
        // Keep an unavailable old binding; it must not prevent a new login.
      }
    }
    await vault.save(userKey, mergeAccount(bindings, verified, profile.gameIds));
    clearUser(userKey);
  };
  const refreshAccounts = async (userKey, bindings) => {
    const rows = [];
    for (const [index, account] of bindings.accounts.entries()) {
      if (!expired(account)) {
        try {
          const result = await getGameIds(browser, account.state);
          account.state = result.state;
          account.gameIds = result.gameIds;
        } catch (error) {
          if (error.code !== 'AUTH_REQUIRED') throw error;
          account.authExpired = true;
        }
      }
      rows.push(...(account.gameIds ?? []).map(profile => ({...profile, account: index + 1, ...(expired(account) ? {authExpired: true} : {})})));
    }
    await vault.save(userKey, bindings);
    if (!rows.length) throw new PiuError('AUTH_REQUIRED', '保存的账号已无法读取档案，请重新扫码或导入 Cookie。');
    return rows;
  };
  const selectAccount = async (userKey, bindings, selector) => {
    if (!selector) return bindings.accounts.find(account => !expired(account)) ?? bindings.accounts[0];
    if (bindings.accounts.length === 1) return bindings.accounts[0];
    const candidates = () => bindings.accounts.flatMap(account => (account.gameIds ?? []).map(profile => ({...profile, binding: account})));
    let rows = candidates();
    try { return resolveGameId(rows, selector).binding; }
    catch (error) { if (error.code !== 'GAME_ID_NOT_FOUND') throw error; }
    await refreshAccounts(userKey, bindings);
    rows = candidates();
    return resolveGameId(rows, selector).binding;
  };
  const run = async (userKey, query, operation) => {
    if (mutations.has(userKey)) throw new PiuError('BUSY', '账号正在绑定或解绑，请稍后再试。');
    const current = pending.get(userKey);
    if (current) {
      if (current.query === query) return current.task;
      throw new PiuError('BUSY', '账号正在读取其他 GAME ID，请等待当前操作完成后重试。');
    }
    if (fetching >= config.maxFetches) throw new PiuError('BUSY', '当前查询人数较多，请稍后再试。');
    const task = (async () => {
      fetching++;
      try { return await operation(); }
      finally { fetching--; }
    })();
    const entry = {query, task};
    pending.set(userKey, entry);
    try { return await task; }
    finally { if (pending.get(userKey) === entry) pending.delete(userKey); }
  };
  let fetching = 0;
  const scoreImage = async (userKey, gameId, kind) => {
    const selector = normalizeGameIdSelector(gameId);
    const cacheKey = `${kind}:${selector}`;
    const query = `image:${cacheKey}`;
    // Profile switching is account state: even cached images respect its lock.
    if (mutations.has(userKey)) throw new PiuError('BUSY', '账号正在绑定或解绑，请稍后再试。');
    const current = pending.get(userKey);
    if (current) {
      if (current.query === query) return current.task;
      throw new PiuError('BUSY', '账号正在读取其他成绩，请等待当前操作完成后重试。');
    }
    const cached = cache.get(userKey)?.get(cacheKey);
    if (cached && Date.now() - cached.at < imageTtl) return cached.picture;
    return run(userKey, query, async () => {
      const bindings = await loadBindings(userKey);
      const account = await selectAccount(userKey, bindings, selector);
      requireActive(account);
      summaries.delete(userKey);
      const type = imageTypes[kind];
      const result = await type.fetch(browser, account.state, {gameId: selector});
      const profile = enrichProfileRanking(result.profile, {dataDir: config.dataDir});
      const picture = await type.render(profile, {loadImage: url => result.images.get(url) ?? null});
      account.state = result.state;
      if (result.gameIds?.length) account.gameIds = result.gameIds;
      await vault.save(userKey, bindings);
      rememberImage(userKey, cacheKey, picture);
      return picture;
    });
  };
  const bridge = await (dependencies.createBridge ?? createBridge)({host: config.host, port: config.port, publicUrl: config.publicUrl,
    ttlMs: config.ttlMs, maxSessions: config.maxSessions,
    createLogin: () => browser.createLogin(),
    validateLogin: page => validateLogin(page, {paginate: false}),
    saveSession: async (userKey, state, profile) => {
      beginMutation(userKey);
      try {
        await pending.get(userKey)?.task.catch(() => {});
        await bindAccount(userKey, state, profile);
        const authorization = loginCallbacks.get(userKey);
        if (authorization && authorization.expiresAt > Date.now()) {
          // Only the explicitly requested admin ranking login receives the full state.
          await authorization.callback(state);
          if (loginCallbacks.get(userKey) === authorization) loginCallbacks.delete(userKey);
        } else if (authorization) loginCallbacks.delete(userKey);
      } finally { endMutation(userKey); }
    }});
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [userKey, bucket] of cache) {
      for (const [selector, value] of bucket) if (now - value.at >= imageTtl) bucket.delete(selector);
      if (!bucket.size) cache.delete(userKey);
    }
    for (const [key, value] of summaries) if (now - value.at >= summaryTtl) summaries.delete(key);
    for (const [key, value] of loginCallbacks) if (now >= value.expiresAt) loginCallbacks.delete(key);
  }, 60000);
  prune.unref();
  return {
    async login(userKey, {onBoundSession} = {}) {
      if (pending.has(userKey) || mutations.has(userKey)) throw new PiuError('BUSY', '账号正在操作，请完成后再登录。');
      if (onBoundSession !== undefined && typeof onBoundSession !== 'function') throw new TypeError('onBoundSession must be a function');
      beginMutation(userKey);
      try {
        const ticket = await bridge.createTicket(userKey);
        // createTicket waits for any prior ticket's save; replace authorization only afterwards.
        loginCallbacks.delete(userKey);
        if (onBoundSession) {
          if (!Number.isFinite(ticket.expiresAt)) throw new Error('Login ticket expiry is required');
          loginCallbacks.set(userKey, {callback: onBoundSession, expiresAt: ticket.expiresAt});
        }
        return ticket;
      } finally { endMutation(userKey); }
    },
    async importCookies(userKey, input) {
      if (pending.has(userKey) || mutations.has(userKey)) throw new PiuError('BUSY', '账号正在操作，请完成后再导入 Cookie。');
      const state = parseCookieState(input);
      if (fetching >= config.maxFetches) throw new PiuError('BUSY', '当前查询人数较多，请稍后再试。');
      beginMutation(userKey);
      fetching++;
      const task = (async () => {
        let context;
        try {
          // Revoke the old remote login before validation. An ordinary Cookie import
          // must never consume an earlier administrator ranking authorization.
          loginCallbacks.delete(userKey);
          await bridge.revoke(userKey);
          context = await browser.context(state);
          const profile = await validateLogin(await context.newPage(), {paginate: false});
          if (!profile) throw new PiuError('AUTH_REQUIRED', 'Cookie 未能通过登录验证，请在自己设备重新登录 PIU 官网后再次导出。');
          await bindAccount(userKey, await context.storageState(), profile);
          return profile;
        } catch (error) {
          if (error instanceof PiuError) {
            if (error.code === 'AUTH_REQUIRED') throw new PiuError('AUTH_REQUIRED', 'Cookie 未能通过登录验证，请在自己设备重新登录 PIU 官网后再次导出。');
            throw error;
          }
          // Browser errors can contain serialized Cookie values; do not propagate them.
          throw new PiuError('COOKIE_IMPORT_FAILED', 'Cookie 导入未完成，请检查官网连接并重新导出 Cookie 后重试。');
        } finally {
          await context?.close().catch(() => {});
        }
      })();
      imports.set(userKey, task);
      try { return await task; }
      finally {
        imports.delete(userKey);
        fetching--;
        endMutation(userKey);
      }
    },
    async best50(userKey, gameId = '') {
      return scoreImage(userKey, gameId, 'b50');
    },
    async recent(userKey, gameId = '') {
      return scoreImage(userKey, gameId, 'recent');
    },
    async data(userKey, gameId = '') {
      return scoreImage(userKey, gameId, 'data');
    },
    async gameIds(userKey) {
      if (mutations.has(userKey)) throw new PiuError('BUSY', '账号正在绑定或解绑，请稍后再试。');
      const current = pending.get(userKey);
      if (current) {
        if (current.query === 'ids') return current.task;
        throw new PiuError('BUSY', '账号正在读取其他 GAME ID，请等待当前操作完成后重试。');
      }
      const cached = summaries.get(userKey);
      if (cached && Date.now() - cached.at < summaryTtl) return structuredClone(cached.gameIds);
      const result = await run(userKey, 'ids', async () => {
        const bindings = await loadBindings(userKey);
        // Membership/order changes can change the first-card default, never a full identity.
        const bucket = cache.get(userKey);
        bucket?.delete('b50:');
        bucket?.delete('recent:');
        bucket?.delete('data:');
        const gameIds = await refreshAccounts(userKey, bindings);
        summaries.set(userKey, {gameIds: structuredClone(gameIds), at: Date.now()});
        trimCaches();
        return gameIds;
      });
      return structuredClone(result);
    },
    async unbind(userKey) {
      beginMutation(userKey);
      try {
        loginCallbacks.delete(userKey);
        await bridge.revoke(userKey);
        // A ticket reservation already in flight may install its callback while revoke waits.
        loginCallbacks.delete(userKey);
        await imports.get(userKey)?.catch(() => {});
        await pending.get(userKey)?.task.catch(() => {});
        clearUser(userKey);
        await vault.delete(userKey);
      } finally { endMutation(userKey); }
    },
    async close() {
      clearInterval(prune);
      loginCallbacks.clear();
      await bridge.close();
      await Promise.allSettled([...imports.values()]);
      await Promise.allSettled([...pending.values()].map(entry => entry.task));
      cache.clear();
      summaries.clear();
      await browser.close();
    },
  };
}
