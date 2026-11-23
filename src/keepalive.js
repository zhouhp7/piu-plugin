import { shanghaiDate } from './ranking-time.js';

const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
export const DEFAULT_WINDOW_HOURS = 24; // 每日 24 小时全天 GMT+8

/**
 * 获取给定 GMT+8 日期字符串当天 00:00:00 的 UTC 时间戳 (ms)
 * @param {string} dateStr YYYYMMDD
 */
export function getShanghaiDayStartMs(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  return Date.UTC(year, month - 1, day, 0, 0, 0) - SHANGHAI_OFFSET;
}

/**
 * 为账号计算下一次保活的目标时间戳 (ms)
 * - 对于每个号具体时间是随机的
 * - 对于每一天也是随机的
 * - 每天在 24 小时内随机时刻执行一次
 * 
 * @param {Object} options
 * @param {number} options.nowMs 当前时间戳
 * @param {string|null} [options.lastKeepAliveDate] 上次保活日期 (YYYYMMDD)
 * @param {function} [options.randomFn] 随机数生成器 (0-1)，默认 Math.random
 * @param {number} [options.windowHours] 保活窗口小时数，默认 24
 * @returns {number} 目标触发时间戳 (ms)
 */
export function calculateNextTargetMs({
  nowMs,
  lastKeepAliveDate = null,
  randomFn = Math.random,
  windowHours = DEFAULT_WINDOW_HOURS,
}) {
  const windowDurationMs = windowHours * 3600 * 1000;
  const nowDateStr = shanghaiDate(new Date(nowMs));
  const todayWindowStart = getShanghaiDayStartMs(nowDateStr);
  const todayWindowEnd = todayWindowStart + windowDurationMs;

  // 1. 如果今天已经保活过，或当前时间已超过今天窗口：安排在明天 24 小时内的随机时刻
  if (lastKeepAliveDate === nowDateStr || nowMs >= todayWindowEnd) {
    const tomorrowWindowStart = todayWindowStart + DAY_MS;
    const offset = Math.floor(randomFn() * windowDurationMs);
    return tomorrowWindowStart + offset;
  }

  // 2. 如果当前时间尚未到达今天窗口起点（极罕见情况，例如前一天深夜跨越）
  if (nowMs < todayWindowStart) {
    const offset = Math.floor(randomFn() * windowDurationMs);
    return todayWindowStart + offset;
  }

  // 3. 当前正处于今天时间窗口内（todayWindowStart <= nowMs < todayWindowEnd）且今天尚未保活
  const remaining = todayWindowEnd - nowMs;
  if (remaining > 1000) {
    const offset = Math.floor(randomFn() * remaining);
    return nowMs + offset;
  }

  // 极度接近窗口结束边界，顺延到明天
  const tomorrowWindowStart = todayWindowStart + DAY_MS;
  const offset = Math.floor(randomFn() * windowDurationMs);
  return tomorrowWindowStart + offset;
}

/**
 * 每日账号自动保活调度管理器
 */
export class KeepAliveManager {
  constructor(service, vault, config = {}, dependencies = {}) {
    this.service = service;
    this.vault = vault;
    this.config = config;
    this.timers = dependencies.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    this.now = dependencies.now ?? (() => new Date());
    this.random = dependencies.random ?? Math.random;
    this.logger = dependencies.logger ?? globalThis.logger ?? console;
    this.windowHours = config.keepAliveWindowHours ?? DEFAULT_WINDOW_HOURS;

    // accountKey (sessionId:accountId) -> { timer, targetMs }
    this.scheduled = new Map();
    this.syncTimer = null;
    this.running = false;
    this.closed = false;
  }

  /**
   * 启动保活服务
   */
  start() {
    if (this.closed || this.running) return;
    if (this.config.keepAliveEnabled === false) {
      this.logger.info?.('[PIU keepalive] 每日账号自动保活功能已在配置中禁用');
      return;
    }
    this.running = true;
    this.logger.info?.('[PIU keepalive] 每日账号自动保活服务已启动 (每天 24 小时内随机时刻执行)');

    // 立即执行一次扫描排期
    this.syncSchedule().catch(err => {
      this.logger.warn?.(`[PIU keepalive] 初始化排程失败: ${err.message}`);
    });

    // 定期（每小时）检查是否有新绑定的账号或变动
    this.syncTimer = this.timers.setInterval(() => {
      if (!this.running || this.closed) return;
      this.syncSchedule().catch(err => {
        this.logger.warn?.(`[PIU keepalive] 定期同步排程失败: ${err.message}`);
      });
    }, 3600 * 1000);
    this.syncTimer?.unref?.();
  }

  /**
   * 扫描所有 sessions 并为所有有效账号安排日程
   */
  async syncSchedule() {
    if (this.closed || !this.running) return;
    const sessionIds = await this.vault.list();
    const activeAccountKeys = new Set();
    const nowMs = this.now().getTime();

    for (const sessionId of sessionIds) {
      let bindings;
      try {
        bindings = await this.vault.loadById(sessionId);
      } catch {
        continue;
      }
      if (!bindings?.accounts?.length) continue;

      for (const account of bindings.accounts) {
        if (account.authExpired) continue;
        const accountKey = `${sessionId}:${account.id}`;
        activeAccountKeys.add(accountKey);

        // 如果该账号尚未排期，为其计算时间并排期
        if (!this.scheduled.has(accountKey)) {
          this.scheduleAccount(sessionId, account, nowMs);
        }
      }
    }

    // 清理已删除或已失效的账号定时器
    for (const [key, entry] of this.scheduled) {
      if (!activeAccountKeys.has(key)) {
        this.timers.clearTimeout(entry.timer);
        this.scheduled.delete(key);
      }
    }
  }

  /**
   * 为单个账号计算随机时间并设置定时器
   */
  scheduleAccount(sessionId, account, currentNowMs = this.now().getTime()) {
    if (this.closed || !this.running) return;
    const accountKey = `${sessionId}:${account.id}`;

    if (this.scheduled.has(accountKey)) {
      this.timers.clearTimeout(this.scheduled.get(accountKey).timer);
      this.scheduled.delete(accountKey);
    }

    const targetMs = calculateNextTargetMs({
      nowMs: currentNowMs,
      lastKeepAliveDate: account.lastKeepAliveDate ?? null,
      randomFn: this.random,
      windowHours: this.windowHours,
    });

    const delayMs = Math.max(100, targetMs - currentNowMs);
    const targetIso = new Date(targetMs).toISOString();
    const playerName = account.gameIds?.[0]?.playerName || account.id;

    this.logger.debug?.(`[PIU keepalive] 账号 [${playerName}] 下次保活预计时间: ${targetIso} (延迟 ${Math.round(delayMs / 1000)}s)`);

    const timer = this.timers.setTimeout(async () => {
      try {
        await this.executeKeepAlive(sessionId, account.id);
      } catch (err) {
        this.logger.warn?.(`[PIU keepalive] 账号 [${playerName}] 保活失败: ${err.message}`);
      } finally {
        // 本次执行完后，自动为明天排期
        if (this.running && !this.closed) {
          try {
            const latestBindings = await this.vault.loadById(sessionId);
            const latestAccount = latestBindings?.accounts?.find(a => a.id === account.id);
            if (latestAccount && !latestAccount.authExpired) {
              this.scheduleAccount(sessionId, latestAccount, this.now().getTime());
            } else {
              this.scheduled.delete(accountKey);
            }
          } catch {
            this.scheduled.delete(accountKey);
          }
        }
      }
    }, delayMs);

    timer?.unref?.();
    this.scheduled.set(accountKey, { timer, targetMs, playerName });
  }

  /**
   * 执行单个账号的保活逻辑
   */
  async executeKeepAlive(sessionId, accountId) {
    if (this.closed || !this.running) return;
    this.logger.info?.(`[PIU keepalive] 开始执行账号自动保活 (session: ${sessionId.slice(0, 8)}, account: ${accountId})`);
    return await this.service.keepAliveAccount(sessionId, accountId);
  }

  /**
   * 获取当前排期状态列表（用于调试或后台查看）
   */
  getStatus() {
    return Array.from(this.scheduled.entries()).map(([key, item]) => ({
      accountKey: key,
      playerName: item.playerName,
      targetAt: new Date(item.targetMs).toISOString(),
    }));
  }

  /**
   * 停止保活服务并清理所有定时器
   */
  close() {
    this.running = false;
    this.closed = true;
    if (this.syncTimer) {
      this.timers.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    for (const [, entry] of this.scheduled) {
      this.timers.clearTimeout(entry.timer);
    }
    this.scheduled.clear();
  }
}
