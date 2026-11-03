import test from 'node:test';
import assert from 'node:assert/strict';
import {renderHelp,HELP_IMAGE_WIDTH} from '../src/help-image.js';
test('help renders a complete PNG without login or external data',async()=>{
  const png=await renderHelp();
  assert.equal(png.subarray(1,4).toString(),'PNG');
  assert.equal(png.readUInt32BE(16),HELP_IMAGE_WIDTH);
  assert.ok(png.readUInt32BE(20)>1000);
});
