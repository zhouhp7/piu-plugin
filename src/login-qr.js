import {createCanvas,loadImage} from '@napi-rs/canvas';
import QRCode from 'qrcode';
import {encodeOutput} from './image-output.js';

/** Match the shared JPEG output size while keeping the QR's error correction. */
export async function renderLoginQr(url) {
  const bytes=await QRCode.toBuffer(url,{width:600,margin:3,errorCorrectionLevel:'M'});
  const source=await loadImage(bytes);
  const canvas=createCanvas(source.width,source.height);
  canvas.getContext('2d').drawImage(source,0,0);
  return encodeOutput(canvas);
}
