import test from 'node:test';
import assert from 'node:assert/strict';
import { supportGuoba } from '../guoba.support.js';

test('guoba.support returns compliant structure and schemas', () => {
  const support = supportGuoba();
  assert.ok(support.pluginInfo);
  assert.equal(support.pluginInfo.name, 'piu-plugin');
  assert.equal(support.pluginInfo.isV3, true);

  assert.ok(support.configInfo);
  assert.ok(Array.isArray(support.configInfo.schemas));
  assert.ok(support.configInfo.schemas.length >= 10);

  const fields = support.configInfo.schemas.filter(s => s.field).map(s => s.field);
  assert.ok(fields.includes('publicUrl'));
  assert.ok(fields.includes('port'));
  assert.ok(fields.includes('sessionKey'));
  assert.ok(fields.includes('rankEnabled'));
  assert.ok(fields.includes('browserPath'));

  assert.equal(typeof support.configInfo.getConfigData, 'function');
  assert.equal(typeof support.configInfo.setConfigData, 'function');
});

test('guoba.support config getters and setters work with mock Result', async () => {
  const support = supportGuoba();
  const config = support.configInfo.getConfigData();
  assert.ok(config);
  assert.equal(typeof config.port, 'number');

  const mockResult = {
    ok: (data, msg) => ({ success: true, data, msg }),
    error: (msg) => ({ success: false, msg }),
  };

  // 校验非法 key
  const invalidKeyRes = support.configInfo.setConfigData({ sessionKey: 'short' }, { Result: mockResult });
  assert.equal(invalidKeyRes.success, false);
  assert.match(invalidKeyRes.msg, /64 位/);

  // 校验非法 publicUrl
  const invalidUrlRes = support.configInfo.setConfigData({ publicUrl: 'http://example.com' }, { Result: mockResult });
  assert.equal(invalidUrlRes.success, false);
  assert.match(invalidUrlRes.msg, /HTTPS/);

  // 动作一键生成 64 位密钥
  assert.ok(support.configInfo.actions?.generateKey);
  const actionRes = support.configInfo.actions.generateKey({}, { Result: mockResult });
  assert.equal(actionRes.success, true);
  assert.match(actionRes.data.key, /^[a-f0-9]{64}$/);
});
