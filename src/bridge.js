import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const randomToken = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const cookieName = 'piu_login';
const keys = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Space']);

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new RequestError(415, '需要 JSON 请求');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw new RequestError(413, '请求内容过长');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RequestError(400, '无效的 JSON'); }
}

function cleanUrl(page) {
  try { const url = new URL(page.url()); return `${url.origin}${url.pathname}`; }
  catch { return ''; }
}

/** Creates the explicitly enabled mobile login service; it does not implement official QR/OAuth. */
export async function createBridge({ host = '127.0.0.1', port = 17381, publicUrl, ttlMs = 300000, maxSessions = 4, createLogin, validateLogin, saveSession, onBound }) {
  const base = new URL(publicUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || !['http:', 'https:'].includes(base.protocol) || (base.protocol !== 'https:' && !loopback)) throw new Error('Login publicUrl requires HTTPS (HTTP is allowed only on localhost)');
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600000) throw new Error('ttlMs must be 1000–600000');
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 100) throw new Error('maxSessions must be 1–100');
  if (![createLogin, validateLogin, saveSession].every(fn => typeof fn === 'function')) throw new TypeError('Login callbacks are required');
  const basePath = base.pathname.replace(/\/+$/, '');
  const cookiePath = `${basePath}/`;
  const html = await readFile(new URL('../web/login.html', import.meta.url), 'utf8');
  const tickets = new Map();
  const sessions = new Map();
  const users = new Map();
  const entries = new Set();
  let closing = false;
  let creatingTickets = Promise.resolve();
  const cookie = (value, seconds) => `${cookieName}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${seconds}${base.protocol === 'https:' ? '; Secure' : ''}`;

  async function dispose(entry) {
    if (!entry.disposal) {
      entry.disposed = true;
      clearTimeout(entry.timer);
      tickets.delete(entry.tokenHash);
      if (entry.sessionHash) sessions.delete(entry.sessionHash);
      if (users.get(entry.userKey) === entry) users.delete(entry.userKey);
      entry.disposal = (async () => {
        await entry.setup?.catch(() => {});
        await entry.work.catch(() => {});
        await entry.context?.close().catch(() => {});
        entries.delete(entry);
      })();
    }
    return entry.disposal;
  }

  function active(entry) {
    if (entry.disposed || Date.now() >= entry.expiresAt) {
      void dispose(entry);
      throw new RequestError(410, '登录链接已过期，请重新发送绑定命令');
    }
  }

  async function work(entry, fn) {
    active(entry);
    if ((entry.pending || 0) >= 3) throw new RequestError(429, '操作过快，请等待上一操作完成');
    entry.pending = (entry.pending || 0) + 1;
    const operation = entry.work.catch(() => {}).then(() => { active(entry); return fn(); });
    entry.work = operation;
    try { return await operation; }
    finally { entry.pending--; }
  }

  function origin(req) {
    if (req.headers.origin !== base.origin) throw new RequestError(403, '请求来源无效');
  }

  function authenticated(req) {
    if (req.headers.origin !== undefined && req.headers.origin !== base.origin) throw new RequestError(403, '请求来源无效');
    const match = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`));
    const value = match?.slice(cookieName.length + 1);
    const entry = validToken(value) ? sessions.get(digest(value)) : null;
    if (!entry) throw new RequestError(401, '登录会话无效，请重新扫码');
    active(entry);
    if (!equal(req.headers['x-csrf-token'], entry.csrf)) throw new RequestError(403, '安全令牌无效');
    return entry;
  }

  async function screenshot(entry) {
    const bytes = await entry.page.screenshot({ type: 'jpeg', quality: 65, timeout: 10000 });
    const viewport = entry.page.viewportSize() || { width: 390, height: 844 };
    return { image: bytes.toString('base64'), imageType: 'image/jpeg', url: cleanUrl(entry.page), ...viewport, expiresAt: entry.expiresAt };
  }

  async function action(entry, input) {
    const page = entry.page;
    const viewport = page.viewportSize() || { width: 390, height: 844 };
    if (input.type === 'click') {
      if (![input.x, input.y].every(Number.isFinite) || input.x < 0 || input.y < 0 || input.x >= viewport.width || input.y >= viewport.height) throw new RequestError(400, '点击坐标无效');
      await page.mouse.click(input.x, input.y, { timeout: 10000 });
    } else if (input.type === 'type') {
      if (typeof input.text !== 'string' || input.text.length > 2048 || (input.replace !== undefined && typeof input.replace !== 'boolean')) throw new RequestError(400, '输入内容无效');
      const editable = await page.evaluate(() => {
        const element = document.activeElement;
        return element instanceof HTMLTextAreaElement && !element.disabled && !element.readOnly
          || element instanceof HTMLInputElement && !element.disabled && !element.readOnly && ['text', 'password', 'email', 'number', 'search', 'tel', 'url'].includes(element.type)
          || element instanceof HTMLElement && element.isContentEditable;
      });
      if (!editable) throw new RequestError(409, '请先点击网页中的输入框');
      if (input.replace !== false) await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText(input.text);
    } else if (input.type === 'key') {
      if (!keys.has(input.key)) throw new RequestError(400, '不允许的按键');
      await page.keyboard.press(input.key);
    } else if (input.type === 'scroll') {
      if (!Number.isFinite(input.deltaY) || Math.abs(input.deltaY) > 1500) throw new RequestError(400, '滚动参数无效');
      await page.mouse.wheel(0, input.deltaY);
    } else throw new RequestError(400, '不支持的操作');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (closing) throw new RequestError(503, '登录服务正在关闭');
      const pathname = new URL(req.url, 'http://local.invalid').pathname;
      const route = pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
      if (req.method === 'GET' && ['/', '/login'].includes(route)) {
        const nonce = randomBytes(18).toString('base64');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html.replaceAll('{{NONCE}}', nonce));
      } else if (req.method === 'POST' && route === '/api/claim') {
        origin(req);
        const input = await body(req);
        const entry = validToken(input.token) ? tickets.get(digest(input.token)) : null;
        if (!entry) throw new RequestError(410, '登录链接无效、已使用或已过期');
        active(entry);
        tickets.delete(entry.tokenHash); // Consume before opening Chromium: concurrent claims cannot reuse a ticket.
        entry.setup = Promise.resolve().then(() => createLogin(entry.userKey)).then(result => {
          if (!result?.context || !result?.page) throw new Error('createLogin must return context and page');
          entry.context = result.context;
          entry.page = result.page;
        });
        try { await entry.setup; active(entry); }
        catch (error) { await dispose(entry); throw error instanceof RequestError ? error : new RequestError(503, '无法启动登录浏览器，请重新绑定'); }
        const token = randomToken();
        entry.csrf = randomToken();
        entry.sessionHash = digest(token);
        sessions.set(entry.sessionHash, entry);
        res.setHeader('Set-Cookie', cookie(token, Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000))));
        json(200, { csrf: entry.csrf, expiresAt: entry.expiresAt });
      } else if (req.method === 'GET' && route === '/api/state') {
        const entry = authenticated(req);
        json(200, await work(entry, () => screenshot(entry)));
      } else if (req.method === 'POST' && route === '/api/action') {
        origin(req);
        const entry = authenticated(req);
        const input = await body(req);
        await work(entry, () => action(entry, input));
        json(200, { ok: true });
      } else if (req.method === 'POST' && route === '/api/finish') {
        origin(req);
        const entry = authenticated(req);
        await body(req);
        await work(entry, async () => {
          let profile;
          try { profile = await validateLogin(entry.page); }
          catch { throw new RequestError(409, '尚未检测到成功登录，请在网页中完成登录后重试'); }
          if (!profile) throw new RequestError(409, '尚未检测到成功登录，请在网页中完成登录后重试');
          active(entry);
          const state = await entry.context.storageState();
          active(entry);
          await saveSession(entry.userKey, state);
          if (onBound) await Promise.resolve().then(() => onBound(entry.userKey, profile)).catch(() => {});
        });
        await dispose(entry);
        res.setHeader('Set-Cookie', cookie('', 0));
        json(200, { ok: true });
      } else if (req.method === 'POST' && route === '/api/cancel') {
        origin(req);
        const entry = authenticated(req);
        await body(req);
        await dispose(entry);
        res.setHeader('Set-Cookie', cookie('', 0));
        json(200, { ok: true });
      } else throw new RequestError(404, '页面不存在');
    } catch (error) {
      if (!res.headersSent) json(error instanceof RequestError ? error.status : 500, { error: error instanceof RequestError ? error.message : '操作失败，请重试或重新绑定' });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });

  return {
    address: server.address(),
    createTicket(userKey) {
      // Serialize reservations so concurrent rebinds cannot exceed the cap or create two tickets per user.
      const operation = creatingTickets.catch(() => {}).then(async () => {
        if (closing) throw new Error('Login service is closed');
        if (typeof userKey !== 'string' || !userKey || userKey.length > 256) throw new TypeError('Invalid user identity');
        if (users.has(userKey)) await dispose(users.get(userKey));
        if (closing) throw new Error('Login service is closed');
        if (entries.size >= maxSessions) throw new Error('登录服务繁忙，请稍后重试');
        const token = randomToken();
        const entry = { userKey, tokenHash: digest(token), expiresAt: Date.now() + ttlMs, disposed: false, work: Promise.resolve() };
        entry.timer = setTimeout(() => { void dispose(entry); }, ttlMs);
        entry.timer.unref();
        entries.add(entry);
        users.set(userKey, entry);
        tickets.set(entry.tokenHash, entry);
        return { url: `${base.origin}${basePath}/login#token=${token}`, expiresAt: entry.expiresAt };
      });
      creatingTickets = operation;
      return operation;
    },
    async revoke(userKey) {
      // Wait for any already queued reservation before revoking it.
      await creatingTickets.catch(() => {});
      const entry = users.get(userKey);
      if (entry) await dispose(entry);
    },
    async close() {
      closing = true;
      await creatingTickets.catch(() => {});
      await Promise.all([...entries].map(dispose));
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
