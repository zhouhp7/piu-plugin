import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {encodeOutput,scaledDimension} from '../src/image-output.js';

test('final images use JPEG with both dimensions reduced to two-thirds and rounded to whole pixels',async()=>{
  const canvas=createCanvas(600,901),ctx=canvas.getContext('2d');
  ctx.fillStyle='#ffca28';ctx.fillRect(0,0,canvas.width,canvas.height);
  const bytes=await encodeOutput(canvas),image=await loadImage(bytes);
  assert.equal(bytes.readUInt16BE(0),0xffd8);
  assert.equal(bytes.readUInt16BE(bytes.length-2),0xffd9);
  assert.equal(image.width,400);assert.equal(image.height,601);
  assert.equal(canvas.width,600);assert.equal(canvas.height,901);
});

test('transparent regions become white in JPEG and scaling never creates an empty image',async()=>{
  const bytes=await encodeOutput(createCanvas(1,1));
  const image=await loadImage(bytes);
  assert.equal(image.width,1);assert.equal(image.height,1);
  const canvas=createCanvas(1,1),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
  const pixel=[...ctx.getImageData(0,0,1,1).data];
  assert.ok(pixel.slice(0,3).every(channel=>channel>=250));assert.equal(pixel[3],255);
  for(const invalid of [0,-1,NaN,Infinity,1.5])assert.throws(()=>scaledDimension(invalid),TypeError);
});
