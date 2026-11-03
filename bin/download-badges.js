#!/usr/bin/env node
// Re-download the exact bundled originals. No account or saved login state is used.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BrowserManager} from '../src/browser.js';
import {fetchOfficialJacket} from '../src/client.js';
import {BADGE_FILES} from '../src/assets.js';

const root = new URL('../assets/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const browser = new BrowserManager({headless: true,
  channel: process.env.PIU_BROWSER_CHANNEL || undefined,
  executablePath: process.env.PIU_BROWSER_PATH || undefined});
try {
  const {context, page} = await browser.createLogin();
  const downloaded = [];
  for (const item of BADGE_FILES) {
    const entry = manifest.assets.find(value => value.kind === item.kind && value.code === item.code && value.file === item.file);
    const filename = item.file.split('/')[1];
    const expectedSource = `https://www.piugame.com/l_img/${item.kind === 'grades' ? 'p2/grade' : 'plate'}/${filename}`;
    if (!entry || entry.source !== expectedSource) throw new Error(`Invalid manifest entry: ${item.code}`);
    const bytes = await fetchOfficialJacket(page, expectedSource);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Official original missing or changed: ${item.code}; existing files were preserved.`);
    }
    downloaded.push({file: item.file, bytes});
    console.log(`Verified ${item.code}`);
  }
  await context.close();
  // Only replace files after every response has matched the recorded original.
  for (const item of downloaded) {
    await mkdir(new URL(item.file.split('/')[0] + '/', root), {recursive: true});
    await writeFile(new URL(item.file, root), item.bytes);
  }
  console.log(`Saved ${downloaded.length} original PIU badges.`);
} finally { await browser.close(); }
