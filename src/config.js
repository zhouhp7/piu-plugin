import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEF_CONFIG_PATH = path.join(ROOT, 'defSet', 'config.yaml');
export const USER_CONFIG_PATH = path.join(ROOT, 'config', 'config.yaml');

export const FIELD_ENV_MAP = {
  publicUrl: 'PIU_PUBLIC_URL',
  host: 'PIU_HOST',
  port: 'PIU_PORT',
  sessionKey: 'PIU_SESSION_KEY',
  loginSeconds: 'PIU_LOGIN_SECONDS',
  maxLogins: 'PIU_MAX_LOGINS',
  maxFetches: 'PIU_MAX_FETCHES',
  cacheSeconds: 'PIU_CACHE_SECONDS',
  sessionDays: 'PIU_SESSION_DAYS',
  rankEnabled: 'PIU_RANK_ENABLED',
  rankKeepAliveMinutes: 'PIU_RANK_KEEPALIVE_MINUTES',
  captureRetries: 'PIU_RANK_CAPTURE_RETRIES',
  jacketPrefetchPages: 'PIU_JACKET_PREFETCH_PAGES',
  jacketPrefetchImages: 'PIU_JACKET_PREFETCH_IMAGES',
  browserPath: 'PIU_BROWSER_PATH',
  browserChannel: 'PIU_BROWSER_CHANNEL',
  proxy: 'PIU_PROXY',
  dataDir: 'PIU_DATA_DIR',
};

function readYamlSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return YAML.parse(content) || {};
    }
  } catch {
    // 忽略格式错误或读取异常
  }
  return {};
}

/** 获取合并后的原始配置对象（defSet + user config） */
export function getRawConfig() {
  const defConfig = readYamlSafe(DEF_CONFIG_PATH);
  const userConfig = readYamlSafe(USER_CONFIG_PATH);
  return { ...defConfig, ...userConfig };
}

/** 保存用户修改的配置项到 config/config.yaml */
export function saveConfig(newData = {}) {
  const userConfig = readYamlSafe(USER_CONFIG_PATH);
  const updated = { ...userConfig, ...newData };
  fs.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(USER_CONFIG_PATH, YAML.stringify(updated, { indent: 2 }), 'utf8');
  return updated;
}

function resolveConfig(env) {
  const isCustomEnv = env !== process.env;
  if (!isCustomEnv) {
    const raw = getRawConfig();
    for (const [field, envKey] of Object.entries(FIELD_ENV_MAP)) {
      if (process.env[envKey] !== undefined) {
        raw[field] = process.env[envKey];
      }
    }
    return raw;
  }

  const def = readYamlSafe(DEF_CONFIG_PATH);
  const raw = { ...def };
  for (const [field, envKey] of Object.entries(FIELD_ENV_MAP)) {
    if (env[envKey] !== undefined) {
      raw[field] = env[envKey];
    } else if (env[field] !== undefined) {
      raw[field] = env[field];
    } else if (field === 'sessionKey') {
      raw[field] = undefined;
    }
  }
  return raw;
}

function parseNumber(val, name, fallback, min, max) {
  const value = Number(val ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function parseBoolean(val, name, fallback) {
  const value = String(val ?? fallback).toLowerCase().trim();
  if (['true', '1'].includes(value)) return true;
  if (['false', '0'].includes(value)) return false;
  throw new Error(`Invalid ${name}`);
}

function browserConfig(raw, env) {
  const proxy = raw.proxy || env?.HTTP_PROXY || env?.http_proxy || env?.ALL_PROXY || env?.all_proxy || undefined;
  return {
    dataDir: path.resolve(ROOT, raw.dataDir || 'data'),
    channel: raw.browserChannel || undefined,
    executablePath: raw.browserPath || undefined,
    proxy: proxy || undefined,
  };
}

export function loadConfig(env = process.env) {
  const raw = resolveConfig(env);
  const key = raw.sessionKey;
  if (!/^[a-f0-9]{64}$/i.test(key ?? '')) throw new Error('请先执行 npm run setup 或在锅巴后台生成 sessionKey (PIU_SESSION_KEY)');
  const publicUrl = raw.publicUrl || 'http://localhost:3210';
  const url = new URL(publicUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    throw new Error('PIU_PUBLIC_URL 必须是 HTTPS 源地址（本地测试可用 http://localhost:3210）');
  }
  return {
    key,
    publicUrl: url.origin,
    host: raw.host || '127.0.0.1',
    port: parseNumber(raw.port, 'PIU_PORT', 3210, 1, 65535),
    cacheMs: parseNumber(raw.cacheSeconds, 'PIU_CACHE_SECONDS', 120, 0, 3600) * 1000,
    ttlMs: parseNumber(raw.loginSeconds, 'PIU_LOGIN_SECONDS', 300, 60, 600) * 1000,
    maxSessions: parseNumber(raw.maxLogins, 'PIU_MAX_LOGINS', 3, 1, 10),
    maxFetches: parseNumber(raw.maxFetches, 'PIU_MAX_FETCHES', 2, 1, 8),
    sessionMaxAgeMs: parseNumber(raw.sessionDays, 'PIU_SESSION_DAYS', 14, 1, 90) * 86400000,
    ...browserConfig(raw, env),
  };
}

/** Reading saved rankings needs no login key; capture sessions remain encrypted. */
export function loadRankingConfig(env = process.env) {
  const raw = resolveConfig(env);
  const key = raw.sessionKey || undefined;
  if (key !== undefined && key !== '' && !/^[a-f0-9]{64}$/i.test(key)) {
    throw new Error('PIU_SESSION_KEY 必须为 64 位十六进制密钥。');
  }
  return {
    ...browserConfig(raw, env),
    key: key || undefined,
    rankEnabled: parseBoolean(raw.rankEnabled, 'PIU_RANK_ENABLED', true),
    rankKeepAliveMs: parseNumber(raw.rankKeepAliveMinutes, 'PIU_RANK_KEEPALIVE_MINUTES', 20, 0, 1440) * 60_000,
    captureRetries: parseNumber(raw.captureRetries, 'PIU_RANK_CAPTURE_RETRIES', 2, 0, 5),
    jacketPrefetchPages: parseNumber(raw.jacketPrefetchPages, 'PIU_JACKET_PREFETCH_PAGES', 3, 0, 20),
    jacketPrefetchImages: parseNumber(raw.jacketPrefetchImages, 'PIU_JACKET_PREFETCH_IMAGES', 120, 1, 500),
  };
}
