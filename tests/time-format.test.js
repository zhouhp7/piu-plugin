import test from 'node:test';
import assert from 'node:assert/strict';
import {formatShanghaiTime} from '../src/time-format.js';

test('display timestamps use GMT+8 including day and year boundaries',()=>{
  assert.equal(formatShanghaiTime('2026-11-02T16:43:19.349Z'),'2026-11-03 00:43:19 GMT+8');
  assert.equal(formatShanghaiTime('2026-12-31T18:00:00Z'),'2027-01-01 02:00:00 GMT+8');
  assert.equal(formatShanghaiTime('2026-11-03T10:00:00+09:00'),'2026-11-03 09:00:00 GMT+8');
});
test('missing, invalid and unzoned timestamps never acquire the host timezone',()=>{
  for(const value of [null,undefined,'bad','2026-11-03 10:00:00'])assert.equal(formatShanghaiTime(value),'—');
});
