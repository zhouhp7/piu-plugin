import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCookieState } from '../src/cookies.js';

const cookie = overrides => ({name: 'PHPSESSID', value: 'test-only-session', domain: '.piugame.com', path: '/', ...overrides});

test('Cookie request headers preserve encoded values and become a PIU-only state', () => {
  const state = parseCookieState(' Cookie: PHPSESSID=test-only-session; selection=a%3Db==; ');
  assert.deepEqual(state.cookies.map(({name, value, domain, path, secure}) => ({name, value, domain, path, secure})), [
    {name: 'PHPSESSID', value: 'test-only-session', domain: '.piugame.com', path: '/', secure: true},
    {name: 'selection', value: 'a%3Db==', domain: '.piugame.com', path: '/', secure: true},
  ]);
  assert.deepEqual(state.origins, []);
});

test('browser JSON exports retain valid scope, normalize attributes and omit foreign sites and localStorage', () => {
  const cookies = [cookie({domain: 'WWW.PIUGAME.COM', httpOnly: true, secure: true, expirationDate: 2000000000, sameSite: 'no_restriction'}),
    cookie({domain: 'api.am-pass.net'}), cookie({domain: 'piugame.com.evil.test'}), cookie({domain: 'unrelated.test'})];
  for (const input of [cookies, {cookies, origins: [{origin: 'https://www.piugame.com', localStorage: [{name: 'untrusted', value: 'x'}]}]}]) {
    const state = parseCookieState(JSON.stringify(input));
    assert.equal(state.cookies.length, 1);
    assert.equal(state.cookies[0].domain, 'www.piugame.com');
    assert.equal(state.cookies[0].sameSite, 'None');
    assert.equal(state.cookies[0].httpOnly, true);
    assert.equal(state.cookies[0].expires, 2000000000);
    assert.deepEqual(state.origins, []);
  }
});

test('expired cookies are dropped and input must contain an unexpired PIU cookie', () => {
  assert.equal(parseCookieState(JSON.stringify([cookie({name: 'old', expires: 10}), cookie({expires: -1})]), 20000).cookies.length, 1);
  for (const input of [[], [cookie({expires: 10})], [cookie({domain: 'api.am-pass.net'})]]) {
    assert.throws(() => parseCookieState(JSON.stringify(input), 20000), {code: 'COOKIE_FORMAT'});
  }
});

test('malformed, ambiguous and oversized credentials fail without echoing submitted data', () => {
  const secret = 'secret-never-echo';
  const invalid = ['', `${secret}`, `x=${secret}\r\nHeader: injected`, `x=${secret}; x=other`, `x=${'a'.repeat(4097)}`,
    `x=${'a'.repeat(32768)}`, JSON.stringify({cookies: 'invalid'}), JSON.stringify([cookie({name: 'bad name', value: secret})]),
    JSON.stringify([cookie({value: `${secret};injected`})]), JSON.stringify([cookie({sameSite: '__proto__', value: secret})]),
    JSON.stringify([cookie({path: 'relative', value: secret})]), JSON.stringify([cookie({httpOnly: 'yes', value: secret})]),
    JSON.stringify([cookie({expires: '2000000000', value: secret})]), JSON.stringify(Array.from({length: 65}, (_, n) => cookie({name: `n${n}`}))),
    JSON.stringify([cookie(), cookie()])];
  for (const input of invalid) assert.throws(() => parseCookieState(input), error => error.code === 'COOKIE_FORMAT' && !error.message.includes(secret));
});
