import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Encrypted session storage. Keep the key separate from backups and source control. */
export class Vault {
  constructor({ directory, key }) {
    if (!directory || typeof directory !== 'string') throw new TypeError('Vault directory is required');
    const bytes = typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key) ? Buffer.from(key, 'hex') : key;
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new TypeError('Vault key must be 32 bytes or 64 hexadecimal characters');
    this.directory = path.resolve(directory);
    this.key = Buffer.from(bytes);
    this.pending = new Map();
  }

  identity(userKey) {
    if (typeof userKey !== 'string' || !userKey || userKey.length > 256) throw new TypeError('Invalid user identity');
    return createHash('sha256').update(userKey).digest('hex');
  }

  file(id) { return path.join(this.directory, `${id}.json.enc`); }

  async serialized(id, operation) {
    const prior = this.pending.get(id) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    this.pending.set(id, next);
    try { return await next; }
    finally { if (this.pending.get(id) === next) this.pending.delete(id); }
  }

  async save(userKey, value) {
    const id = this.identity(userKey);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Session must be JSON serializable');
    return this.serialized(id, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      // Binding ciphertext to its filename also prevents swapping different users' files.
      cipher.setAAD(Buffer.from(`piu-session-v1:${id}`));
      const ciphertext = Buffer.concat([cipher.update(encoded, 'utf8'), cipher.final()]);
      const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
      const temporary = path.join(this.directory, `.${id}.${randomBytes(12).toString('hex')}.tmp`);
      try {
        await writeFile(temporary, envelope, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file(id));
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
  }

  async load(userKey) {
    const id = this.identity(userKey);
    return this.serialized(id, async () => {
      let raw;
      try { raw = await readFile(this.file(id), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      try {
        const envelope = JSON.parse(raw);
        const iv = Buffer.from(envelope.iv, 'base64');
        const tag = Buffer.from(envelope.tag, 'base64');
        if (envelope.version !== 1 || iv.length !== 12 || tag.length !== 16 || typeof envelope.data !== 'string') throw new Error('Invalid envelope');
        const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAAD(Buffer.from(`piu-session-v1:${id}`));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
      } catch { throw new Error('Session cannot be decrypted; check the vault key and stored file'); }
    });
  }

  async delete(userKey) {
    const id = this.identity(userKey);
    return this.serialized(id, () => unlink(this.file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; }));
  }
}
