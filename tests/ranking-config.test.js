import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig, loadRankingConfig} from '../src/config.js';

test('offline ranking configuration needs no key but normal login configuration does', () => {
  const config = loadRankingConfig({});
  assert.equal(config.key, undefined);
  assert.equal(config.rankEnabled, true);
  assert.equal(config.rankKeepAliveMs, 20 * 60_000);
  assert.equal(config.captureRetries, 2);
  assert.throws(() => loadConfig({}), /PIU_SESSION_KEY/);
  assert.throws(() => loadRankingConfig({PIU_SESSION_KEY: 'invalid'}), /PIU_SESSION_KEY/);
});

test('ranking scheduling controls have explicit booleans and bounded retry and keepalive values', () => {
  const config = loadRankingConfig({PIU_SESSION_KEY: 'a'.repeat(64), PIU_RANK_ENABLED: 'false', PIU_RANK_KEEPALIVE_MINUTES: '0', PIU_RANK_CAPTURE_RETRIES: '5'});
  assert.equal(config.rankEnabled, false);
  assert.equal(config.rankKeepAliveMs, 0);
  assert.equal(config.captureRetries, 5);
  for (const env of [
    {PIU_RANK_ENABLED: 'perhaps'}, {PIU_RANK_KEEPALIVE_MINUTES: '-1'},
    {PIU_RANK_KEEPALIVE_MINUTES: '0.5'}, {PIU_RANK_KEEPALIVE_MINUTES: '1441'},
    {PIU_RANK_CAPTURE_RETRIES: '-1'}, {PIU_RANK_CAPTURE_RETRIES: '6'},
  ]) assert.throws(() => loadRankingConfig(env), /Invalid PIU_RANK_/);
});
