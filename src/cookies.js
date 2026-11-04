import { PiuError } from './errors.js';

const MAX_INPUT_BYTES = 32768;
const MAX_COOKIES = 64;
const DOMAINS = new Set(['piugame.com', 'www.piugame.com']);
const SAME_SITES = new Map([['strict', 'Strict'], ['lax', 'Lax'], ['none', 'None'], ['no_restriction', 'None'], ['unspecified', 'Lax']]);
const invalid = () => new PiuError('COOKIE_FORMAT', 'Cookie 格式无效。请发送 PIU 官网请求的 Cookie 值，或该站点导出的 Cookie JSON。');
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[!#$%&'*+\-.^_`|~\da-z]+$/i.test(value);
const validValue = value => typeof value === 'string' && value.length <= 4096 && /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(value);

/** Parse credentials without ever including submitted names or values in errors. */
export function parseCookieState(input, now = Date.now()) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw invalid();
  const text = input.trim();
  if (!text) throw invalid();
  let values;
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw invalid(); }
    values = Array.isArray(parsed) ? parsed : parsed?.cookies;
    if (!Array.isArray(values)) throw invalid();
  } else {
    const header = text.replace(/^cookie:\s*/i, '');
    if (/[\r\n]/.test(header)) throw invalid();
    values = header.split(';').filter(part => part.trim()).map(part => {
      const separator = part.indexOf('=');
      if (separator < 1) throw invalid();
      return {name: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim(), domain: '.piugame.com', path: '/', secure: true};
    });
  }
  if (!values.length || values.length > MAX_COOKIES) throw invalid();
  const cookies = [], seen = new Set();
  for (const item of values) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.domain !== 'string') throw invalid();
    const domain = item.domain.toLowerCase();
    if (!DOMAINS.has(domain.replace(/^\./, ''))) continue;
    if (!validName(item.name) || !validValue(item.value)) throw invalid();
    const path = item.path ?? '/';
    if (typeof path !== 'string' || path.length > 1024 || !path.startsWith('/') || /[\x00-\x20\x7f;]/.test(path)) throw invalid();
    const expires = item.expires ?? item.expirationDate ?? -1;
    if (!Number.isFinite(expires) || expires < -1) throw invalid();
    if (expires !== -1 && expires <= now / 1000) continue;
    const sameSite = SAME_SITES.get(String(item.sameSite ?? 'Lax').toLowerCase());
    if (!sameSite || ['httpOnly', 'secure'].some(key => item[key] !== undefined && typeof item[key] !== 'boolean')) throw invalid();
    const id = `${domain}\0${path}\0${item.name}`;
    if (seen.has(id)) throw invalid();
    seen.add(id);
    cookies.push({name: item.name, value: item.value, domain, path, expires,
      httpOnly: item.httpOnly ?? false, secure: item.secure ?? true, sameSite});
  }
  if (!cookies.length) throw new PiuError('COOKIE_FORMAT', '未找到有效的 PIU 官网 Cookie，请重新登录后导出 piugame.com 的 Cookie。');
  // Imported local storage is unnecessary for this flow and must not enter the account context.
  return {cookies, origins: []};
}
