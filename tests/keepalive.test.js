import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNextTargetMs, getShanghaiDayStartMs, KeepAliveManager } from '../src/keepalive.js';
import { shanghaiDate } from '../src/ranking-time.js';

test('getShanghaiDayStartMs returns exact 00:00:00 GMT+8 timestamp', () => {
  const startMs = getShanghaiDayStartMs('20261118');
  const d = new Date(startMs);
  assert.equal(d.toISOString(), '2026-11-17T16:00:00.000Z');
  assert.equal(shanghaiDate(d), '20261118');
});

test('calculateNextTargetMs schedules within remaining time of today if not yet kept alive today', () => {
  // 2026-11-18 17:00:00 GMT+8 = 2026-11-18 09:00:00 UTC
  const nowMs = new Date('2026-11-18T09:00:00.000Z').getTime();
  
  // 距离今天 24:00 (次日 00:00 GMT+) 还剩 7 小时 (25,200,000 ms)
  // randomFn 返回 0.5 -> 应该在 17:00 + 3.5h = 20:30 GMT+8 (12:30 UTC)
  const targetMs = calculateNextTargetMs({
    nowMs,
    randomFn: () => 0.5,
  });

  const targetDate = new Date(targetMs);
  assert.equal(shanghaiDate(targetDate), '20261118');
  assert.equal(targetDate.toISOString(), '2026-11-18T12:30:00.000Z');
});

test('calculateNextTargetMs schedules for tomorrow across 24h if account already kept alive today', () => {
  // 当前处于 2026-11-18 17:00:00 GMT+8，但该账号今天已经执行过
  const nowMs = new Date('2026-11-18T09:00:00.000Z').getTime();

  // 明天 00:00 GMT+8 + 0.5 * 24h = 明天中午 12:00 GMT+8 (04:00 UTC)
  const targetMs = calculateNextTargetMs({
    nowMs,
    lastKeepAliveDate: '20261118',
    randomFn: () => 0.5,
  });

  const targetDate = new Date(targetMs);
  // 必须调度到明天 11-19
  assert.equal(shanghaiDate(targetDate), '20261119');
  assert.equal(targetDate.toISOString(), '2026-11-19T04:00:00.000Z');
});

test('randomness: different accounts receive different times across 24h and same account receives different times across days', () => {
  const nowMs = new Date('2026-11-18T09:00:00.000Z').getTime();

  // 账号 1 随机数 0.1，账号 2 随机数 0.8
  const targetAccount1 = calculateNextTargetMs({ nowMs, randomFn: () => 0.1 });
  const targetAccount2 = calculateNextTargetMs({ nowMs, randomFn: () => 0.8 });
  assert.notEqual(targetAccount1, targetAccount2);

  // 同一账号在第二天重新计算，随机数变动（例如从 0.1 变为 0.6）
  const targetDay2 = calculateNextTargetMs({
    nowMs: targetAccount1 + 1000,
    lastKeepAliveDate: '20261118',
    randomFn: () => 0.6,
  });
  assert.notEqual(targetDay2, targetAccount1);
  assert.equal(shanghaiDate(new Date(targetDay2)), '20261119');
});

test('KeepAliveManager does nothing when keepAliveEnabled is false', async () => {
  let listCalled = false;
  const mockVault = {
    list: async () => { listCalled = true; return []; },
  };
  const manager = new KeepAliveManager({}, mockVault, { keepAliveEnabled: false });
  manager.start();
  assert.equal(listCalled, false);
  assert.equal(manager.running, false);
  manager.close();
});

test('KeepAliveManager schedules accounts, triggers keepalive, and reschedules for next day', async () => {
  let currentTime = new Date('2026-11-18T09:00:00.000Z').getTime(); // 下午 17:00 GMT+8
  const timeouts = new Map();
  let timerIdSeq = 1;

  const mockTimers = {
    setTimeout: (fn, delay) => {
      const id = timerIdSeq++;
      timeouts.set(id, { fn, delay, due: currentTime + delay });
      return id;
    },
    clearTimeout: id => {
      timeouts.delete(id);
    },
    setInterval: () => 999,
    clearInterval: () => {},
  };

  const storedBindings = {
    userKey: 'test-user',
    accounts: [
      { id: 'acc1', state: { cookies: [] }, gameIds: [{ id: '1', playerName: 'PLAYER#1234' }] },
      { id: 'acc2', state: { cookies: [] }, gameIds: [{ id: '2', playerName: 'SECOND#5678' }], authExpired: true }, // 已过期应跳过
    ],
  };

  const mockVault = {
    list: async () => ['session-1'],
    loadById: async id => (id === 'session-1' ? structuredClone(storedBindings) : null),
    saveById: async (id, val) => { Object.assign(storedBindings, structuredClone(val)); },
  };

  const keepAliveCalls = [];
  const mockService = {
    keepAliveAccount: async (sid, aid) => {
      keepAliveCalls.push({ sid, aid });
      // 模拟更新 account
      const acc = storedBindings.accounts.find(a => a.id === aid);
      if (acc) {
        acc.lastKeepAliveDate = shanghaiDate(new Date(currentTime));
        acc.lastKeepAliveAt = currentTime;
      }
      return { success: true };
    },
  };

  const manager = new KeepAliveManager(mockService, mockVault, { keepAliveEnabled: true }, {
    timers: mockTimers,
    now: () => new Date(currentTime),
    random: () => 0.5,
  });

  manager.start();
  // 等待异步 syncSchedule 完成
  await new Promise(resolve => process.nextTick(resolve));

  // 验证：只有未过期的 acc1 排期了，acc2 被跳过
  const status = manager.getStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0].accountKey, 'session-1:acc1');

  // 快进时间到执行时间
  const entry = timeouts.values().next().value;
  assert.ok(entry);
  currentTime = entry.due;
  await entry.fn();

  // 验证 keepAliveAccount 被调用
  assert.equal(keepAliveCalls.length, 1);
  assert.deepEqual(keepAliveCalls[0], { sid: 'session-1', aid: 'acc1' });
  assert.equal(storedBindings.accounts[0].lastKeepAliveDate, '20261118');

  // 验证执行后为第二天自动重新排期
  const statusAfter = manager.getStatus();
  assert.equal(statusAfter.length, 1);
  assert.equal(statusAfter[0].accountKey, 'session-1:acc1');
  assert.equal(shanghaiDate(new Date(statusAfter[0].targetAt)), '20261119');

  manager.close();
  assert.equal(manager.getStatus().length, 0);
});
