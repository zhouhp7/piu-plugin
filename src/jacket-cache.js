import {createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, readdir, lstat, rename, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadImage} from '@napi-rs/canvas';

const LIMIT = 4_000_000;
const pending = new Map();
const managerCaches = new WeakMap();

/** Only immutable official song art is shared. Account/avatar URLs are excluded. */
export function canonicalJacketUrl(value, {keepQuery = false} = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['piugame.com', 'www.piugame.com'].includes(url.hostname) ||
        url.username || url.password || (url.port && url.port !== '443') ||
        !/^\/data\/song_img2?\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i.test(url.pathname)) return null;
    url.hostname = 'www.piugame.com';
    url.hash = '';
    if (!keepQuery) url.search = '';
    return url.href;
  } catch { return null; }
}

async function isImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMIT) return false;
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 16 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!png && !jpeg && !webp) return false;
  if (png && (bytes.readUInt32BE(16) > 8192 || bytes.readUInt32BE(20) > 8192 ||
      bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_777_216)) return false;
  try {
    const image = await loadImage(bytes);
    return image.width > 0 && image.height > 0 && image.width <= 8192 && image.height <= 8192 && image.width * image.height <= 16_777_216;
  } catch { return false; }
}

/** Original bytes, persistent across users and sessions; there is no expiry. */
export class JacketCache {
  constructor({directory, onError} = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('JacketCache requires directory.');
    this.directory = path.resolve(directory);
    this.onError = typeof onError === 'function' ? onError : () => {};
  }
  fileFor(value) {
    const canonical = canonicalJacketUrl(value);
    if (!canonical) return null;
    const extension = path.extname(new URL(canonical).pathname).toLowerCase();
    return path.join(this.directory, `${createHash('sha256').update(canonical).digest('hex')}${extension}`);
  }
  async get(value) {
    const file = this.fileFor(value);
    if (!file) return null;
    let info;
    try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isFile()) return null;
    if (info.size > LIMIT || !info.size) { await unlink(file); return null; }
    const bytes = await readFile(file);
    if (await isImage(bytes)) return bytes;
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return null;
  }
  async getOrLoad(value, loader) {
    const file = this.fileFor(value);
    const source = canonicalJacketUrl(value, {keepQuery: true});
    if (!file || !source || typeof loader !== 'function') return null;
    try { const bytes = await this.get(value); if (bytes) return bytes; }
    catch (error) { this.onError(error); }
    if (pending.has(file)) return pending.get(file);
    const task = (async () => {
      // Another caller/process may have completed the same immutable asset.
      try { const bytes = await this.get(value); if (bytes) return bytes; }
      catch (error) { this.onError(error); }
      const provided = await loader(source);
      const bytes = provided instanceof Uint8Array ? Buffer.from(provided) : provided;
      if (!await isImage(bytes)) return null;
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await mkdir(this.directory, {recursive: true});
        await writeFile(temporary, bytes, {flag: 'wx'});
        await rename(temporary, file);
      } catch (error) { this.onError(error); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') this.onError(error); }); }
      return bytes;
    })();
    pending.set(file, task);
    try { return await task; } finally { if (pending.get(file) === task) pending.delete(file); }
  }
  async stats() {
    let names;
    try { names = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return {count: 0, bytes: 0, directory: this.directory}; throw error; }
    let count = 0, bytes = 0;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.(?:png|jpe?g|webp)$/.test(name)) continue;
      const file = path.join(this.directory, name);
      const info = await lstat(file);
      if (info.isFile() && info.size <= LIMIT) {
        const data = await readFile(file);
        if (await isImage(data)) { count++; bytes += data.length; }
      }
    }
    return {count, bytes, directory: this.directory};
  }
}

export function getJacketCache(browserManager, {directory} = {}) {
  const target = path.resolve(directory ?? path.join(browserManager.config?.dataDir ?? fileURLToPath(new URL('../data/', import.meta.url)), 'jackets'));
  let caches = managerCaches.get(browserManager);
  if (!caches) { caches = new Map(); managerCaches.set(browserManager, caches); }
  if (!caches.has(target)) caches.set(target, new JacketCache({directory: target}));
  return caches.get(target);
}
