import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/vault.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'piu-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, vault: new Vault({ directory, key: Buffer.alloc(32, 7) }) };
}

test('vault encrypts, persists, and deletes sessions without exposing identities', async t => {
  const { directory, vault } = await fixture(t);
  const state = { cookies: [{ name: 'session', value: 'secret-session-token' }] };
  await vault.save('qq:123456', state);
  const [name] = await readdir(directory);
  assert.match(name, /^[a-f0-9]{64}\.json\.enc$/);
  assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(path.join(directory, name), 'utf8')).includes('secret-session-token'));
  assert.deepEqual(await vault.load('qq:123456'), state);
  assert.deepEqual(await new Vault({ directory, key: '07'.repeat(32) }).load('qq:123456'), state);
  await vault.delete('qq:123456');
  assert.equal(await vault.load('qq:123456'), null);
});

test('vault rejects tampering, wrong keys, and ciphertext copied between users', async t => {
  const { directory, vault } = await fixture(t);
  await vault.save('one', { token: 'one' });
  await assert.rejects(new Vault({ directory, key: Buffer.alloc(32, 8) }).load('one'), /cannot be decrypted/);
  await rename(vault.file(vault.identity('one')), vault.file(vault.identity('two')));
  await assert.rejects(vault.load('two'), /cannot be decrypted/);
  await writeFile(vault.file(vault.identity('two')), 'invalid');
  await assert.rejects(vault.load('two'), /cannot be decrypted/);
});

test('delete waits for pending writes so unbind cannot resurrect an encrypted session', async t => {
  const { vault } = await fixture(t);
  await Promise.all([vault.save('user', { token: 'a' }), vault.save('user', { token: 'b' }), vault.delete('user')]);
  assert.equal(await vault.load('user'), null);
  assert.throws(() => new Vault({ directory: '.', key: 'bad' }), /32 bytes/);
});
