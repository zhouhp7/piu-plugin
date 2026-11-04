import test from 'node:test';
import assert from 'node:assert/strict';
import {loadImage} from '@napi-rs/canvas';
import {renderLoginQr} from '../src/login-qr.js';

test('login QR is exported as a 400 by 400 JPEG',async()=>{
  const bytes=await renderLoginQr('https://bot.example/login#token=test-only');
  assert.equal(bytes.subarray(0,2).toString('hex'),'ffd8');
  const image=await loadImage(bytes);
  assert.equal(image.width,400);assert.equal(image.height,400);
});
