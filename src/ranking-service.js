import path from 'node:path';
import {RankingStore} from './ranking-store.js';
import {RankingReader, rankingSessionState} from './ranking-client.js';
import {Vault} from './vault.js';
import {PiuError} from './errors.js';
import {comparisonDates, nextDaily01, parseDate, shanghaiDate, zoned01} from './ranking-time.js';
import {buildRankComparison, canonicalPlayer, parseFollowBatch, resolveFollowBatch} from './ranking-follow.js';
import {renderRankComparison} from './rank-render.js';
import {getJacketCache} from './jacket-cache.js';
import {prefetchJackets} from './jacket-prefetch.js';
import {parseCookieState} from './cookies.js';

export function createRankingService(config, dependencies = {}) {
  const store = dependencies.store ?? new RankingStore({filename: path.join(config.dataDir, 'rankings.sqlite')});
  const reader = dependencies.reader ?? new RankingReader(config);
  const vault = dependencies.vault ?? (config.key ? new Vault({directory: path.join(config.dataDir, 'ranking-auth'), key: config.key}) : null);
  const now = dependencies.now ?? (() => new Date());
  const render = dependencies.render ?? renderRankComparison;
  const timers = dependencies.timers ?? {setTimeout, clearTimeout, setInterval, clearInterval};
  const logger = dependencies.logger ?? globalThis.logger ?? console;
  const captures = new Map();
  let networkTail = Promise.resolve(), started = false, closing = false;
  let dailyTimer, heartbeatTimer, lastReported;

  function open() { if (closing) throw new PiuError('RANK_CLOSED', '排行榜服务已关闭。'); }
  const report = error => {
    const message = error instanceof PiuError ? error.message : '排行榜采集失败，请检查服务器网络和数据库。';
    if (message !== lastReported) logger.warn?.(`[PIU rank] ${message}`);
    lastReported = message;
  };
  function serial(operation) {
    const task = networkTail.catch(() => {}).then(() => { open(); return operation(); });
    networkTail = task;
    return task;
  }
  async function session() {
    if (!vault) throw new PiuError('RANK_AUTH', '请管理员先配置 PIU_SESSION_KEY，并私聊 #piu ranklogin 授权排行榜采集。');
    const saved = await vault.load('leaderboard-reader');
    if (!saved?.state?.cookies?.length) throw new PiuError('RANK_AUTH', '排行榜需要专用登录会话，请机器人主人私聊 #piu ranklogin 授权。');
    return saved;
  }
  async function saveReadResult(result, saved, kind, date) {
    const capturedAt = result.capturedAt ?? now().toISOString();
    if (shanghaiDate(capturedAt) !== date) throw new PiuError('RANK_DATE', '采集跨越了 GMT+8 日期边界，未将当前数据记入过去日期。');
    if (vault && saved) await vault.save('leaderboard-reader', {...saved, state: rankingSessionState(result.state), lastUsedAt: now().toISOString()});
    const meta = store.saveSnapshot({date, kind, capturedAt, scheduledAt: kind === 'manual' ? null : zoned01(date),
      sourceUpdatedAt: result.sourceUpdatedAt ?? null, entries: result.entries, audit: result.audit ?? null});
    lastReported = undefined;
    return meta;
  }
  async function capture({kind = 'manual', date = shanghaiDate(now())} = {}) {
    open(); parseDate(date);
    if (!['manual', 'scheduled', 'catchup'].includes(kind)) throw new PiuError('RANK_DATE', '快照类型无效。');
    if (date !== shanghaiDate(now())) throw new PiuError('RANK_DATE', '只能采集当前日期；无法补抓已经过去的历史排行榜。');
    if (kind !== 'manual' && now().getTime() < new Date(zoned01(date)).getTime()) throw new PiuError('RANK_DATE', '尚未到当天 GMT+8 的 01:00，不能提前生成定时快照。');
    const key = `${date}:${kind}`;
    if (captures.has(key)) return captures.get(key);
    const task = serial(async () => {
      const saved = await session();
      let result;
      for (let attempt = 0; attempt <= (config.captureRetries ?? 2); attempt++) {
        try { result = await reader.fetch(saved.state); break; }
        catch (error) {
          if (error.code === 'RANK_AUTH' || error.code === 'AUTH_REQUIRED' || attempt >= (config.captureRetries ?? 2)) throw error;
          await new Promise(resolve => timers.setTimeout(resolve, Math.min(5000, 1000 * (attempt + 1))));
        }
      }
      return saveReadResult(result, saved, kind, date);
    });
    captures.set(key, task);
    try { return await task; } finally { if (captures.get(key) === task) captures.delete(key); }
  }
  async function runDue(kind = 'catchup') {
    open();
    const date = shanghaiDate(now());
    if (now().getTime() < new Date(zoned01(date)).getTime()) return null;
    const existing = store.getSnapshot(date);
    if (existing && existing.kind !== 'manual') return existing;
    return capture({kind, date});
  }
  function schedule({keepAlive = false} = {}) {
    if (closing || !started) return;
    const target = nextDaily01(now());
    dailyTimer = timers.setTimeout(async () => {
      try { await runDue('scheduled'); } catch (error) { report(error); }
      finally { schedule({keepAlive}); }
    }, Math.max(1, target.getTime() - now().getTime()));
    if (!keepAlive) dailyTimer?.unref?.();
  }
  async function keepAlive() {
    open();
    if (captures.size) return;
    return serial(async () => {
      const saved = await session();
      const result = await (reader.keepAlive ? reader.keepAlive(saved.state) : reader.fetch(saved.state));
      // Keep-alive refreshes the session only. It never manufactures a dated ranking sample.
      await vault.save('leaderboard-reader', {...saved, state: rankingSessionState(result.state), lastUsedAt: now().toISOString()});
      lastReported = undefined;
    });
  }
  async function ensureIndex() {
    let latest = store.latestSnapshot();
    if (latest) return latest;
    if (captures.size) { await [...captures.values()][0]; latest = store.latestSnapshot(); }
    if (!latest) { await capture(); latest = store.latestSnapshot(); }
    return latest;
  }
  async function prewarm({onlyIfEmpty = false} = {}) {
    open();
    const maxPages = config.jacketPrefetchPages ?? 3;
    if (!maxPages) return {disabled: true};
    return serial(async () => {
      const directory = path.join(config.dataDir, 'jackets');
      const cache = getJacketCache(reader.browser, {directory});
      const stats = await cache.stats();
      if (onlyIfEmpty && stats.count) return {skipped: true, stats};
      const saved = await session();
      return prefetchJackets(reader.browser, saved.state, {cacheDirectory: directory, maxPages,
        maxImages: config.jacketPrefetchImages ?? 120});
    });
  }
  async function setSession(state) {
    open();
    if (!vault) throw new PiuError('RANK_AUTH', '请先配置有效的 PIU_SESSION_KEY。');
    const metadata = await serial(async () => {
      const filtered = rankingSessionState(state);
      if (!filtered.cookies.length) throw new PiuError('RANK_AUTH', '未取得官方登录会话，请重新登录。');
      const result = await reader.fetch(filtered);
      const saved = {state: rankingSessionState(result.state), savedAt: now().toISOString()};
      await vault.save('leaderboard-reader', saved);
      return saveReadResult(result, saved, 'manual', shanghaiDate(result.capturedAt ?? now()));
    });
    if (config.jacketPrefetchPages > 0) void prewarm({onlyIfEmpty: true}).catch(report);
    return metadata;
  }
  return {
    capture, runDue, keepAlive, prewarm, setSession,
    async importCookies(input) {
      open();
      if (!vault) throw new PiuError('RANK_AUTH', '请先配置有效的 PIU_SESSION_KEY。');
      const state = parseCookieState(input);
      try { return await setSession(state); }
      catch (error) {
        if (error instanceof PiuError) {
          if (['RANK_AUTH', 'AUTH_REQUIRED'].includes(error.code)) {
            throw new PiuError('RANK_AUTH', 'Cookie 未能通过排行榜登录验证，请在自己设备重新登录 PIU 官网后再次导出，并由主人私聊 #piu ranklogin sid=会话值。');
          }
          throw error;
        }
        // Browser errors may contain serialized credentials; never expose them.
        throw new PiuError('RANK_COOKIE_IMPORT_FAILED', '排行榜 Cookie 导入未完成，请检查官网连接和会话加密配置后重试。');
      }
    },
    start({keepAlive: keepProcessAlive = false} = {}) {
      open();
      if (started || config.rankEnabled === false) return;
      started = true;
      schedule({keepAlive: keepProcessAlive});
      const interval = config.rankKeepAliveMs ?? 20 * 60_000;
      if (interval > 0) {
        heartbeatTimer = timers.setInterval(() => { void keepAlive().catch(report); }, interval);
        if (!keepProcessAlive) heartbeatTimer?.unref?.();
      }
      // Recover today's missed slot honestly, retaining the actual later capture time.
      void runDue().catch(report);
    },
    status() {
      return {started, nextCaptureAt: config.rankEnabled === false ? null : nextDaily01(now()).toISOString(),
        snapshots: store.listSnapshots(), keyConfigured: Boolean(vault)};
    },
    latestAudit() {
      open();
      const latest = store.latestSnapshot();
      if (!latest) throw new PiuError('RANK_MISSING', '数据库目前还没有排行榜快照。');
      return {date: latest.date, capturedAt: latest.capturedAt, ...latest.audit};
    },
    listFollows(owner) { open(); return store.getFollows(owner); },
    async follow(owner, input) {
      open();
      const selectors = parseFollowBatch(input);
      const latest = await ensureIndex();
      const resolved = resolveFollowBatch(latest.entries, selectors);
      const previous = new Set(store.getFollows(owner).map(row => row.playerKey));
      const combined = new Set([...previous, ...resolved.map(row => row.playerKey)]);
      if (combined.size > 100) throw new PiuError('RANK_FOLLOW_LIMIT', '每份关注列表最多关注 100 个档案。');
      const references = resolved.map(({playerKey, gameId, tag, sourceId}) => ({playerKey, gameId, tag, ...(sourceId ? {sourceId} : {})}));
      return {added: references.filter(row => !previous.has(row.playerKey)), follows: store.follow(owner, references)};
    },
    unfollow(owner, input) {
      open();
      const selectors = parseFollowBatch(input);
      const current = store.getFollows(owner);
      const resolved = resolveFollowBatch(current, selectors);
      return {removed: resolved, follows: store.unfollow(owner, resolved.map(row => row.playerKey))};
    },
    async rank(owner, first, second) {
      open();
      const dates = comparisonDates(first, second, now());
      const current = store.getSnapshot(dates.firstDate), previous = store.getSnapshot(dates.secondDate);
      const missing = [!current && dates.firstDate, !previous && dates.secondDate].filter(Boolean);
      if (missing.length) {
        const available = [...new Set(store.listSnapshots().map(row => row.date))].slice(0, 12).join('、');
        throw new PiuError('RANK_MISSING', `缺少 ${[...new Set(missing)].join('、')} 的排行榜快照，无法计算真实变化。${available ? `已有日期：${available}。` : '数据库目前还没有快照。'}不会用当前数据替代历史。`);
      }
      const follows = store.getFollows(owner);
      if (!follows.length) throw new PiuError('RANK_FOLLOW_EMPTY', '关注列表为空，请先使用 #piu follow SHAWN#1477 YINYBEST#3231 CHIPHANT#5633。');
      return render(buildRankComparison(current, previous, follows));
    },
    async preview(owner, date) {
      open();
      const current = date ? store.getSnapshot(parseDate(date).date) : store.latestSnapshot();
      if (!current) throw new PiuError('RANK_MISSING', '没有可预览的真实快照。');
      return render(buildRankComparison(current, null, store.getFollows(owner)));
    },
    async close() {
      if (closing) return;
      closing = true; started = false;
      timers.clearTimeout(dailyTimer); timers.clearInterval(heartbeatTimer);
      await networkTail.catch(() => {});
      await reader.close();
      store.close();
    },
  };
}
