import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
function loadEnv(env) {
  if (env === process.env) {
    try { process.loadEnvFile(path.join(ROOT, '.env')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function number(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
function boolean(env, name, fallback) {
  const value = String(env[name] ?? fallback).toLowerCase().trim();
  if (['true', '1'].includes(value)) return true;
  if (['false', '0'].includes(value)) return false;
  throw new Error(`Invalid ${name}`);
}
function browserConfig(env) {
  return {
    dataDir: path.resolve(ROOT, env.PIU_DATA_DIR || 'data'),
    channel: env.PIU_BROWSER_CHANNEL || undefined,
    executablePath: env.PIU_BROWSER_PATH || undefined,
  };
}
export function loadConfig(env = process.env) {
  loadEnv(env);
  const key = env.PIU_SESSION_KEY;
  if (!/^[a-f0-9]{64}$/i.test(key ?? '')) throw new Error('请先执行 npm run setup 生成 PIU_SESSION_KEY');
  const publicUrl = env.PIU_PUBLIC_URL || 'http://localhost:3210';
  const url = new URL(publicUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    throw new Error('PIU_PUBLIC_URL 必须是 HTTPS 源地址（本地测试可用 http://localhost:3210）');
  }
  return {
    key, publicUrl: url.origin,
    host: env.PIU_HOST || '127.0.0.1', port: number(env, 'PIU_PORT', 3210, 1, 65535),
    cacheMs: number(env, 'PIU_CACHE_SECONDS', 120, 0, 3600) * 1000,
    ttlMs: number(env, 'PIU_LOGIN_SECONDS', 300, 60, 600) * 1000,
    maxSessions: number(env, 'PIU_MAX_LOGINS', 3, 1, 10),
    maxFetches: number(env, 'PIU_MAX_FETCHES', 2, 1, 8),
    sessionMaxAgeMs: number(env, 'PIU_SESSION_DAYS', 14, 1, 90) * 86400000,
    ...browserConfig(env),
  };
}

/** Reading saved rankings needs no login key; capture sessions remain encrypted. */
export function loadRankingConfig(env = process.env) {
  loadEnv(env);
  const key = env.PIU_SESSION_KEY || undefined;
  if (key !== undefined && !/^[a-f0-9]{64}$/i.test(key)) throw new Error('PIU_SESSION_KEY 必须为 64 位十六进制密钥。');
  return {
    ...browserConfig(env), key,
    rankEnabled: boolean(env, 'PIU_RANK_ENABLED', true),
    rankKeepAliveMs: number(env, 'PIU_RANK_KEEPALIVE_MINUTES', 20, 0, 1440) * 60_000,
    captureRetries: number(env, 'PIU_RANK_CAPTURE_RETRIES', 2, 0, 5),
    jacketPrefetchPages: number(env, 'PIU_JACKET_PREFETCH_PAGES', 3, 0, 20),
    jacketPrefetchImages: number(env, 'PIU_JACKET_PREFETCH_IMAGES', 120, 1, 500),
  };
}
