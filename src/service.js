import path from 'node:path';
import { BrowserManager } from './browser.js';
import { fetchProfile, fetchRecent, fetchGameIds, readProfile, piuOnlyState } from './client.js';
import { Vault } from './vault.js';
import { createBridge } from './bridge.js';
import { renderBest50, renderRecent } from './render.js';
import { PiuError } from './errors.js';
import { normalizeGameIdSelector } from './parser.js';
import { enrichProfileRanking } from './profile-ranking.js';

export async function createService(config, dependencies = {}) {
  const vault = dependencies.vault ?? new Vault({directory: path.join(config.dataDir, 'sessions'), key: config.key});
  const browser = dependencies.browser ?? new BrowserManager(config);
  const getProfile = dependencies.fetchProfile ?? fetchProfile;
  const getRecent = dependencies.fetchRecent ?? fetchRecent;
  const getGameIds = dependencies.fetchGameIds ?? fetchGameIds;
  const render = dependencies.renderBest50 ?? renderBest50;
  const renderRecentImage = dependencies.renderRecent ?? renderRecent;
  // Buckets keep cards isolated while bounding memory by both users and card images.
  const cache = new Map();
  const summaries = new Map();
  const pending = new Map();
  const mutations = new Map();
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
  const rememberImage = (userKey, selector, png) => {
    let bucket = cache.get(userKey);
    if (!bucket) { bucket = new Map(); cache.set(userKey, bucket); }
    bucket.set(selector, {png, at: Date.now()});
    if (bucket.size > 16) bucket.delete(bucket.keys().next().value);
    trimCaches();
  };
  const loadSession = async userKey => {
    const session = await vault.load(userKey);
    if (!session) throw new PiuError('AUTH_REQUIRED', '请先私聊发送 #piu 登录，扫码绑定自己的账号。');
    if (Date.now() - session.savedAt > config.sessionMaxAgeMs) {
      clearUser(userKey);
      await vault.delete(userKey);
      throw new PiuError('AUTH_REQUIRED', '保存的登录已到期，请私聊发送 #piu 登录。');
    }
    return session;
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
    if (cached && Date.now() - cached.at < imageTtl) return cached.png;
    return run(userKey, query, async () => {
      const session = await loadSession(userKey);
      summaries.delete(userKey);
      const recent = kind === 'recent';
      const result = await (recent ? getRecent : getProfile)(browser, session.state, {gameId: selector});
      const profile = recent ? result.profile : enrichProfileRanking(result.profile, {dataDir: config.dataDir});
      const png = await (recent ? renderRecentImage : render)(profile, {loadImage: url => result.images.get(url) ?? null});
      await vault.save(userKey, {...session, state: result.state});
      rememberImage(userKey, cacheKey, png);
      return png;
    });
  };
  const bridge = await (dependencies.createBridge ?? createBridge)({host: config.host, port: config.port, publicUrl: config.publicUrl,
    ttlMs: config.ttlMs, maxSessions: config.maxSessions,
    createLogin: () => browser.createLogin(),
    validateLogin: page => readProfile(page, {paginate: false}),
    saveSession: async (userKey, state) => {
      beginMutation(userKey);
      try {
        await pending.get(userKey)?.task.catch(() => {});
        await vault.save(userKey, {state: piuOnlyState(state), savedAt: Date.now()});
        clearUser(userKey);
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
      const ticket = await bridge.createTicket(userKey);
      // createTicket waits for any prior ticket's save; replace authorization only afterwards.
      loginCallbacks.delete(userKey);
      if (onBoundSession) {
        if (!Number.isFinite(ticket.expiresAt)) throw new Error('Login ticket expiry is required');
        loginCallbacks.set(userKey, {callback: onBoundSession, expiresAt: ticket.expiresAt});
      }
      return ticket;
    },
    async best50(userKey, gameId = '') {
      return scoreImage(userKey, gameId, 'b50');
    },
    async recent(userKey, gameId = '') {
      return scoreImage(userKey, gameId, 'recent');
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
        const session = await loadSession(userKey);
        // Membership/order changes can change the first-card default, never a full identity.
        const bucket = cache.get(userKey);
        bucket?.delete('b50:');
        bucket?.delete('recent:');
        const result = await getGameIds(browser, session.state);
        await vault.save(userKey, {...session, state: result.state});
        summaries.set(userKey, {gameIds: structuredClone(result.gameIds), at: Date.now()});
        trimCaches();
        return result.gameIds;
      });
      return structuredClone(result);
    },
    async unbind(userKey) {
      beginMutation(userKey);
      try {
        loginCallbacks.delete(userKey);
        await bridge.revoke(userKey);
        await pending.get(userKey)?.task.catch(() => {});
        clearUser(userKey);
        await vault.delete(userKey);
      } finally { endMutation(userKey); }
    },
    async close() {
      clearInterval(prune);
      loginCallbacks.clear();
      await bridge.close();
      await Promise.allSettled([...pending.values()].map(entry => entry.task));
      cache.clear();
      summaries.clear();
      await browser.close();
    },
  };
}
