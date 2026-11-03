import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDate, shanghaiDate, zoned01, defaultComparison, comparisonDates, nextDaily01} from '../src/ranking-time.js';

test('ranking dates accept real leap dates and reject malformed or nonexistent dates', () => {
  assert.deepEqual(parseDate('20240229'), {year: 2024, month: 2, day: 29, date: '20240229'});
  for (const value of ['20260229', '20261131', '20261301', '20260001', '20260100', '2026-11-03', '2026113', 20261103, '', '00000101']) {
    assert.throws(() => parseDate(value), {code: 'RANK_DATE'});
  }
});

test('01:00 GMT+8 maps to the preceding UTC day and ignores the host zone', () => {
  assert.equal(zoned01('20261103'), '2026-11-02T17:00:00.000Z');
  assert.equal(zoned01('20260101'), '2025-12-31T17:00:00.000Z');
  assert.equal(shanghaiDate('2026-11-02T15:59:59Z'), '20261102');
  assert.equal(shanghaiDate('2026-11-02T16:00:00Z'), '20261103');
  assert.equal(shanghaiDate('2026-11-03T01:00:00+08:00'), '20261103');
});

test('default comparison uses exact calendar Mondays including a future Monday 01:00', () => {
  assert.deepEqual(defaultComparison('2026-11-03T08:00:00+08:00'), {firstDate: '20261102', secondDate: '20261026'});
  assert.deepEqual(defaultComparison('2026-11-02T00:30:00+08:00'), {firstDate: '20261102', secondDate: '20261026'});
  assert.deepEqual(defaultComparison('2026-11-01T23:59:59+08:00'), {firstDate: '20261026', secondDate: '20261019'});
  assert.deepEqual(defaultComparison('2024-01-01T00:01:00+08:00'), {firstDate: '20240101', secondDate: '20231225'});
});

test('explicit comparisons preserve user ordering and require both dates', () => {
  assert.deepEqual(comparisonDates('20261003', '20261103'), {firstDate: '20261003', secondDate: '20261103'});
  assert.deepEqual(comparisonDates(undefined, undefined, '2026-11-03T08:00:00+08:00'), {firstDate: '20261102', secondDate: '20261026'});
  assert.throws(() => comparisonDates('20261103'), {code: 'RANK_DATE'});
  assert.throws(() => comparisonDates(undefined, '20261103'), {code: 'RANK_DATE'});
  assert.throws(() => comparisonDates('20260229', '20261103'), {code: 'RANK_DATE'});
});

test('daily scheduling advances strictly past 01:00 with GMT+8 day and year boundaries', () => {
  assert.equal(nextDaily01('2026-11-03T00:59:59+08:00').toISOString(), '2026-11-02T17:00:00.000Z');
  assert.equal(nextDaily01('2026-11-03T01:00:00+08:00').toISOString(), '2026-11-03T17:00:00.000Z');
  assert.equal(nextDaily01('2026-11-03T23:59:59+08:00').toISOString(), '2026-11-03T17:00:00.000Z');
  assert.equal(nextDaily01('2026-12-31T23:59:59+08:00').toISOString(), '2026-12-31T17:00:00.000Z');
});
