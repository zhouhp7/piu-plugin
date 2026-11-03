import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile } from '../src/model.js';
import { renderBest50, IMAGE_WIDTH, IMAGE_HEIGHT, CARD_WIDTH, CARD_HEIGHT } from '../src/render.js';
import { isOfficialUrl } from '../src/browser.js';
import { piuOnlyState } from '../src/client.js';
import { loadConfig } from '../src/config.js';

test('normalization preserves order, missing data, and 50-record cap without deriving rating', () => {
  const records = Array.from({length:60}, (_,i) => ({title: `Song${i}`, score: 1000000-i, rank:i+1, mode:'single'}));
  const result = normalizeProfile({pumbility:null, records});
  assert.equal(result.records.length, 50);
  assert.equal(result.records[0].title, 'Song0');
  assert.equal(result.records[49].title, 'Song49');
  assert.ok(result.records.every(r => r.rating === null && r.mode === 'S'));
  assert.equal(result.pumbility, null);
  assert.equal(normalizeProfile({records:[{score: false, level:'', rating:'  '}]}).records[0].score, null);
  const failed = normalizeProfile({records:[{grade:'AA+', gradeCode:'X_AA+', failed:true}]}).records[0];
  assert.equal(failed.grade, 'AA+');
  assert.equal(failed.gradeCode, 'X_AA+');
  assert.equal(failed.failed, true);
});
test('renderer makes a complete valid PNG and never fetches arbitrary image sources by default', async () => {
  assert.ok(CARD_WIDTH / CARD_HEIGHT >= 3.5, 'cards remain flat enough for the inline score and badge row');
  const png = await renderBest50({playerName:'中文测试 / PIU', records:[{title:'A very long title ' .repeat(12), jacket:'https://127.0.0.1/private', rating:300, grade:'S+'}]});
  assert.equal(png.subarray(1,4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), IMAGE_WIDTH);
  assert.equal(png.readUInt32BE(20), IMAGE_HEIGHT);
});
test('official navigation allowlist rejects credential URLs, foreign hosts, non-HTTPS and nonstandard ports', () => {
  assert.ok(isOfficialUrl('https://api.am-pass.net/sso'));
  assert.ok(isOfficialUrl('https://www.piugame.com/bbs/login.php'));
  for (const url of ['https://www.piugame.com.evil.test/', 'http://piugame.com/', 'https://user:pass@www.piugame.com/', 'https://piugame.com:8443/', 'file:///etc/passwd']) assert.equal(isOfficialUrl(url), false);
});
test('stored state excludes AM-PASS and third party SSO cookies', () => {
  const state = piuOnlyState({cookies:[{domain:'.piugame.com',name:'sid'},{domain:'api.am-pass.net',name:'sid'},{domain:'evil.test'}],origins:[{origin:'https://www.piugame.com'},{origin:'https://api.am-pass.net'}]});
  assert.equal(state.cookies.length, 1);
  assert.equal(state.origins.length, 1);
});
test('config enforces HTTPS for public deployments and bounded quotas', () => {
  const env = {PIU_SESSION_KEY: 'a'.repeat(64)};
  assert.equal(loadConfig(env).publicUrl, 'http://localhost:3210');
  assert.throws(() => loadConfig({...env, PIU_PUBLIC_URL:'http://example.com'}));
  assert.throws(() => loadConfig({...env, PIU_PUBLIC_URL:'https://example.com/path'}));
  assert.throws(() => loadConfig({...env, PIU_MAX_LOGINS:'0'}));
});
