import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getRawConfig, saveConfig, DEF_CONFIG_PATH, USER_CONFIG_PATH } from '../src/config.js';

test('defSet config.yaml contains valid default properties', () => {
  const defContent = fs.readFileSync(DEF_CONFIG_PATH, 'utf8');
  const def = YAML.parse(defContent);

  assert.equal(def.publicUrl, 'http://localhost:3210');
  assert.equal(def.host, '127.0.0.1');
  assert.equal(def.port, 3210);
  assert.equal(def.sessionKey, '');
  assert.equal(def.rankEnabled, true);
  assert.equal(def.rankKeepAliveMinutes, 20);
  assert.equal(def.captureRetries, 2);
  assert.equal(def.maxLogins, 3);
  assert.equal(def.maxFetches, 2);
  assert.equal(def.cacheSeconds, 120);
  assert.equal(def.sessionDays, 14);
});

test('yaml-config getRawConfig returns merged configuration', () => {
  const raw = getRawConfig();
  assert.ok(raw);
  assert.equal(typeof raw.publicUrl, 'string');
  assert.equal(typeof raw.port, 'number');
  assert.equal(typeof raw.rankEnabled, 'boolean');
  assert.equal(raw.host, '127.0.0.1');
});

test('yaml-config saveConfig persists and updates raw configuration', () => {
  const testKey = 'b'.repeat(64);
  const backupExists = fs.existsSync(USER_CONFIG_PATH);
  const backupContent = backupExists ? fs.readFileSync(USER_CONFIG_PATH, 'utf8') : null;

  try {
    saveConfig({ sessionKey: testKey, port: 4321 });
    const raw = getRawConfig();
    assert.equal(raw.sessionKey, testKey);
    assert.equal(raw.port, 4321);
    assert.equal(raw.host, '127.0.0.1'); // 保留默认值
  } finally {
    if (backupContent !== null) {
      fs.writeFileSync(USER_CONFIG_PATH, backupContent, 'utf8');
    } else if (fs.existsSync(USER_CONFIG_PATH)) {
      fs.unlinkSync(USER_CONFIG_PATH);
    }
  }
});
