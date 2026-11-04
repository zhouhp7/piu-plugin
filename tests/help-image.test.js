import test from 'node:test';
import assert from 'node:assert/strict';
import {loadImage} from '@napi-rs/canvas';
import {renderHelp,HELP_IMAGE_WIDTH} from '../src/help-image.js';
test('help renders a reduced JPEG without login or external data',async()=>{
  const jpeg=await renderHelp();
  assert.equal(jpeg.subarray(0,2).toString('hex'),'ffd8');
  const image=await loadImage(jpeg);
  assert.equal(image.width,HELP_IMAGE_WIDTH);
  assert.equal(image.width,800);
  assert.ok(image.height>1000);
});
