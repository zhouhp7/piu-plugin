import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadImage} from '@napi-rs/canvas';
import {GRADE_CODES, PLATE_CODES, BADGE_FILES, loadBadgeAssets} from '../src/assets.js';

test('all requested grade and plate originals are bundled, including failed grade variants', async () => {
  const {grades, plates} = await loadBadgeAssets();
  assert.deepEqual([...grades.keys()], [...GRADE_CODES, ...GRADE_CODES.map(code => `X_${code}`)]);
  assert.deepEqual([...plates.keys()], [...PLATE_CODES]);
  assert.equal(grades.size, 24);
  assert.equal(plates.size, 8);
});

test('bundled PNGs match recorded original bytes and dimensions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
  const assets = await loadBadgeAssets();
  assert.equal(manifest.assets.length, BADGE_FILES.length);
  for (const item of BADGE_FILES) {
    const entry = manifest.assets.find(value => value.kind === item.kind && value.code === item.code);
    assert.ok(entry, item.code);
    assert.equal(entry.file, item.file);
    const expectedPath = item.kind === 'grades' ? '/l_img/p2/grade/' : '/l_img/plate/';
    assert.equal(entry.source, `https://www.piugame.com${expectedPath}${item.file.split('/')[1]}`);
    const bytes = assets[item.kind].get(item.code);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]), item.code);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, item.code);
    const image = await loadImage(bytes);
    assert.deepEqual([image.width, image.height], item.kind === 'grades' ? [300,178] : [100,50], item.code);
    assert.deepEqual([entry.width, entry.height], [image.width,image.height]);
  }
});
