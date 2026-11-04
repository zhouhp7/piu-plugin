import {createCanvas} from '@napi-rs/canvas';

export const OUTPUT_SCALE = 2 / 3;
export const JPEG_QUALITY = 85;

export function scaledDimension(value) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError('Image dimensions must be positive integers');
  return Math.max(1, Math.round(value * OUTPUT_SCALE));
}

/** Keep drawing coordinates unchanged; resize and encode each final image once. */
export async function encodeOutput(canvas) {
  const output = createCanvas(scaledDimension(canvas.width), scaledDimension(canvas.height));
  const ctx = output.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, output.width, output.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, output.width, output.height);
  return output.encode('jpeg', JPEG_QUALITY);
}
