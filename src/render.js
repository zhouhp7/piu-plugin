import { createCanvas, loadImage as decodeImage } from '@napi-rs/canvas';
import { loadBadgeAssets } from './assets.js';
import { normalizeProfile } from './model.js';

export const CARD_WIDTH = 600;
export const CARD_HEIGHT = 150;
const GRID_COLUMNS = 5;
const GRID_ROWS = 10;
const GRID_GAP = 20;
const PAGE_MARGIN = 80;
const GRID_TOP = 264;
const GRID_BOTTOM = GRID_TOP + CARD_HEIGHT * GRID_ROWS + GRID_GAP * (GRID_ROWS - 1);
const FOOTER_LINE = GRID_BOTTOM + 34;
export const IMAGE_WIDTH = PAGE_MARGIN * 2 + CARD_WIDTH * GRID_COLUMNS + GRID_GAP * (GRID_COLUMNS - 1);
export const IMAGE_HEIGHT = FOOTER_LINE + 84;

const COLORS = {
  cyan: '#60f0ed', pink: '#ff69b4', ink: '#090e1b', light: '#f3f7ff', muted: '#91a3bc',
};
const MODE_COLORS = {
  S: '#60f0ed', D: '#b39aff', SP: '#ff83bd', DP: '#ffb473', COOP: '#8ee8a3', UNKNOWN: '#a5b3c7',
};
const LEVEL_COLORS = {
  S: '#ef4555', SP: '#ef4555', D: '#21a769', DP: '#21a769', COOP: '#7986a3', UNKNOWN: '#7986a3',
};
const DEFAULT_FONT = 'Arial, "Noto Sans CJK SC", "Noto Sans", "Microsoft YaHei", "PingFang SC", sans-serif';

function roundRect(ctx, x, y, width, height, radius = 16) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function panel(ctx, x, y, width, height, radius, fill, stroke) {
  roundRect(ctx, x, y, width, height, radius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function font(ctx, size, weight = 400, family = DEFAULT_FONT) {
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textBaseline = 'alphabetic';
}

function fitText(ctx, value, x, y, maxWidth, size, color, weight = 400, family = DEFAULT_FONT) {
  font(ctx, size, weight, family);
  let output = String(value);
  if (ctx.measureText(output).width > maxWidth) {
    const parts = [...output];
    while (parts.length && ctx.measureText(`${parts.join('')}…`).width > maxWidth) parts.pop();
    output = `${parts.join('')}…`;
  }
  ctx.fillStyle = color;
  ctx.fillText(output, x, y);
  return output;
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

function hash(value) {
  let seed = 2166136261;
  for (const char of String(value)) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}

function arrow(ctx, x, y, size, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.55);
  ctx.lineTo(size * 0.55, 0);
  ctx.lineTo(size * 0.23, 0);
  ctx.lineTo(size * 0.23, size * 0.55);
  ctx.lineTo(-size * 0.23, size * 0.55);
  ctx.lineTo(-size * 0.23, 0);
  ctx.lineTo(-size * 0.55, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function placeholder(ctx, x, y, size, title, isDemo, family) {
  const seed = hash(title);
  const hue = seed % 360;
  const gradient = ctx.createLinearGradient(x, y, x + size, y + size);
  gradient.addColorStop(0, `hsl(${hue}, 65%, 31%)`);
  gradient.addColorStop(1, `hsl(${(hue + 70) % 360}, 62%, 11%)`);
  ctx.save();
  roundRect(ctx, x, y, size, size, 10); ctx.clip();
  ctx.fillStyle = gradient; ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = '#ffffff24'; ctx.lineWidth = 1;
  for (let i = -1; i < 6; i += 1) {
    ctx.beginPath(); ctx.moveTo(x + i * 28, y); ctx.lineTo(x + i * 28 - size, y + size); ctx.stroke();
  }
  const angle = ((seed % 4) * Math.PI) / 2 + Math.PI / 4;
  arrow(ctx, x + size / 2, y + size * 0.43, size * 0.38, angle, '#ffffffb3');
  ctx.fillStyle = '#060d20a8'; ctx.fillRect(x, y + size - 22, size, 22);
  font(ctx, 10, 700, family); ctx.fillStyle = '#ffffffbc'; ctx.textAlign = 'center';
  ctx.fillText(isDemo ? 'DEMO ART' : 'NO JACKET', x + size / 2, y + size - 7);
  ctx.restore();
}

function imageCover(ctx, image, x, y, width, height, radius = 10) {
  if (!image || !image.width || !image.height) return false;
  const scale = Math.max(width / image.width, height / image.height);
  const sw = width / scale;
  const sh = height / scale;
  ctx.save();
  roundRect(ctx, x, y, width, height, radius); ctx.clip();
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, width, height);
  ctx.restore();
  return true;
}

function imageContain(ctx, image, x, y, width, height) {
  if (!image || !image.width || !image.height) return false;
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  return true;
}

let badgeImagesPromise;
async function loadBadgeImages() {
  if (!badgeImagesPromise) {
    badgeImagesPromise = loadBadgeAssets().then(async ({ grades, plates }) => {
      async function decodeMap(bytes) {
        return new Map(await Promise.all([...bytes.entries()].map(async ([key, value]) => [key, await decodeImage(value)])));
      }
      const [gradeImages, plateImages] = await Promise.all([decodeMap(grades), decodeMap(plates)]);
      return { grades: gradeImages, plates: plateImages };
    }).catch(error => { badgeImagesPromise = undefined; throw error; });
  }
  return badgeImagesPromise;
}

async function loadImages(profile, options) {
  const images = new Map();
  if (typeof options.loadImage !== 'function') return images;
  const sources = [...new Set([profile.avatar, ...profile.records.map((record) => record.jacket)].filter(Boolean))];
  let cursor = 0;
  async function worker() {
    while (cursor < sources.length) {
      const source = sources[cursor++];
      try {
        const provided = await options.loadImage(source);
        // Only an explicitly provided loader may read URLs or files. The
        // renderer itself decodes bytes, never arbitrary strings or locations.
        const image = Buffer.isBuffer(provided) || provided instanceof Uint8Array
          ? await decodeImage(provided)
          : provided;
        if (!image || typeof image === 'string' || !image.width || !image.height) {
          throw new TypeError('loadImage must return an Image, Canvas, Buffer, or Uint8Array.');
        }
        images.set(source, image);
      } catch (error) {
        if (typeof options.onImageError === 'function') options.onImageError(error, source);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
  return images;
}

function drawBackground(ctx) {
  const bg = ctx.createLinearGradient(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  bg.addColorStop(0, '#111b30'); bg.addColorStop(0.46, '#0a1020'); bg.addColorStop(1, '#0a0e1a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  const glow = ctx.createRadialGradient(1950, 110, 0, 1950, 110, 880);
  glow.addColorStop(0, '#ea41831b'); glow.addColorStop(1, '#ea418300');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, IMAGE_WIDTH, 1000);
  const cyanGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 950);
  cyanGlow.addColorStop(0, '#22d9dd12'); cyanGlow.addColorStop(1, '#22d9dd00');
  ctx.fillStyle = cyanGlow; ctx.fillRect(0, 0, 1100, 1100);
  ctx.strokeStyle = '#ffffff03'; ctx.lineWidth = 1;
  for (let x = 0; x <= IMAGE_WIDTH; x += 44) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, IMAGE_HEIGHT); ctx.stroke(); }
  for (let y = 0; y <= IMAGE_HEIGHT; y += 44) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(IMAGE_WIDTH, y); ctx.stroke(); }
  ctx.fillStyle = COLORS.cyan; ctx.fillRect(80, 0, 440, 6);
  ctx.fillStyle = COLORS.pink; ctx.fillRect(532, 0, 110, 6);
}

function drawHeader(ctx, profile, images, family) {
  fitText(ctx, 'PIU  /  PERSONAL PERFORMANCE', 80, 67, 1200, 23, COLORS.cyan, 700, family);
  ctx.textAlign = 'right';
  fitText(ctx, profile.demo ? 'FABRICATED DEMO DATA' : 'PIUGAME.COM  /  MY PUMBILITY', IMAGE_WIDTH - 80, 67, 850, 21,
    profile.demo ? '#ffb88c' : COLORS.muted, 700, family);
  ctx.textAlign = 'left';
  fitText(ctx, 'PUMBILITY', 76, 162, 1130, 90, COLORS.light, 900, family);
  fitText(ctx, 'BEST 50', 706, 162, 1000, 90, COLORS.cyan, 900, family);

  const infoX = 1150;
  const gradient = ctx.createLinearGradient(infoX, 84, IMAGE_WIDTH - 80, 192);
  gradient.addColorStop(0, '#1a2a40'); gradient.addColorStop(1, '#171e32');
  panel(ctx, infoX, 84, IMAGE_WIDTH - infoX - 80, 108, 18, gradient, '#40536b');
  ctx.fillStyle = COLORS.cyan; ctx.fillRect(infoX, 108, 4, 60);
  if (!imageCover(ctx, images.get(profile.avatar), 1170, 102, 72, 72, 16)) {
    panel(ctx, 1170, 102, 72, 72, 16, '#273f53', '#4c7182');
    arrow(ctx, 1206, 138, 34, Math.PI / 4, COLORS.cyan);
  }
  const totalX = profile.ranking ? 2210 : 2590;
  fitText(ctx, profile.playerName, 1270, 151, totalX - 1344, 40, COLORS.light, 700, family);

  ctx.strokeStyle = '#42546a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(totalX - 42, 106); ctx.lineTo(totalX - 42, 170); ctx.stroke();
  fitText(ctx, 'TOTAL PUMBILITY', totalX, 116, 445, 17, COLORS.muted, 700, family);
  fitText(ctx, formatNumber(profile.pumbility, 3), totalX - 4, 166, 450, 52, COLORS.cyan, 700, family);
  if (profile.ranking) {
    const rankingX = 2760;
    ctx.beginPath(); ctx.moveTo(rankingX - 40, 106); ctx.lineTo(rankingX - 40, 170); ctx.stroke();
    fitText(ctx, 'WORLD RANK', rankingX, 116, 320, 17, COLORS.muted, 700, family);
    const rank = /^\d[\d,]*$/.test(profile.ranking) ? `#${profile.ranking}` : profile.ranking;
    fitText(ctx, rank, rankingX - 4, 164, 320, 47, COLORS.light, 700, family);
  }

  ctx.textAlign = 'right';
  fitText(ctx, `${profile.records.length} / 50 RECORDS`, IMAGE_WIDTH - 455, 237, 600, 18, COLORS.muted, 400, family);
  ctx.textAlign = 'left';
  for (const [offset, mode, label] of [[386, 'S', 'SINGLE'], [207, 'D', 'DOUBLE']]) {
    ctx.fillStyle = LEVEL_COLORS[mode];
    ctx.beginPath(); ctx.arc(IMAGE_WIDTH - offset, 230, 9, 0, Math.PI * 2); ctx.fill();
    fitText(ctx, label, IMAGE_WIDTH - offset + 18, 237, 132, 18, COLORS.muted, 400, family);
  }
}

function drawRating(ctx, value, x, y, maxWidth, color, family) {
  const output = formatNumber(value, 3);
  let size = 64;
  font(ctx, size, 700, family);
  while (ctx.measureText(output).width > maxWidth && size > 32) font(ctx, --size, 700, family);
  ctx.fillStyle = color;
  ctx.fillText(output, x, y, maxWidth);
  return Math.min(maxWidth, ctx.measureText(output).width);
}

function drawLevel(ctx, record, centerX, centerY, family) {
  ctx.fillStyle = LEVEL_COLORS[record.mode] ?? LEVEL_COLORS.UNKNOWN;
  ctx.beginPath(); ctx.arc(centerX, centerY, 23, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 25px ${family}`; ctx.fillStyle = '#ffffff';
  ctx.fillText(formatNumber(record.level), centerX, centerY + 1, 38);
  ctx.restore();
}

function drawCard(ctx, record, slot, x, y, images, badges, family, isDemo) {
  const w = CARD_WIDTH; const h = CARD_HEIGHT;
  if (!record) {
    panel(ctx, x, y, w, h, 16, '#101827', '#243044');
    fitText(ctx, `#${String(slot + 1).padStart(2, '0')}`, x + 18, y + 33, 100, 20, '#415169', 700, family);
    ctx.textAlign = 'center';
    fitText(ctx, 'NO RECORD', x + w / 2, y + 88, w - 30, 23, '#617188', 700, family);
    fitText(ctx, 'Not available on the source page', x + w / 2, y + 118, w - 35, 16, '#526077', 400, family);
    ctx.textAlign = 'left';
    return;
  }
  const accent = MODE_COLORS[record.mode];
  const gradient = ctx.createLinearGradient(x, y, x + w, y + h);
  gradient.addColorStop(0, '#1b283e'); gradient.addColorStop(1, '#141d2e');
  panel(ctx, x, y, w, h, 16, gradient, '#35435b');
  ctx.save();
  roundRect(ctx, x, y, w, h, 16); ctx.clip();
  ctx.fillStyle = accent; ctx.fillRect(x, y, w, 3);
  ctx.restore();

  fitText(ctx, `#${String(record.rank).padStart(2, '0')}`, x + 17, y + 33, 57, 20, '#b4c7df', 700, family);
  fitText(ctx, record.title, x + 79, y + 33, w - 97, 23, COLORS.light, 700, family);
  if (!imageCover(ctx, images.get(record.jacket), x + 17, y + 47, 92, 92)) {
    placeholder(ctx, x + 17, y + 47, 92, record.title, isDemo, family);
  }

  fitText(ctx, 'PUMBILITY', x + 130, y + 62, 224, 12, '#9eb1cb', 700, family);
  drawRating(ctx, record.rating, x + 127, y + 119, 224, accent, family);
  const grade = record.grade.toUpperCase();
  const gradeKey = record.failed ? `X_${grade}` : grade;
  const gradeImage = badges.grades.get(gradeKey) ?? badges.grades.get(record.gradeCode?.toUpperCase()) ?? badges.grades.get(grade);
  const plateImage = badges.plates.get(record.plate?.toUpperCase());
  // Keep the three icon slots anchored to the card's right edge, independent
  // of how many decimal digits the source score contains.
  const gradeX = x + w - 237;
  const plateX = gradeX + 66 + 12;
  if (!imageContain(ctx, gradeImage, gradeX, y + 74, 66, 42)) {
    fitText(ctx, '—', gradeX + 17, y + 105, 48, 25, '#c1d1e6', 700, family);
  }
  if (!imageContain(ctx, plateImage, plateX, y + 74, 78, 42)) {
    fitText(ctx, '—', plateX + 22, y + 105, 48, 25, '#c1d1e6', 700, family);
  }
  drawLevel(ctx, record, plateX + 78 + 16 + 23, y + 95, family);
}

function drawFooter(ctx, profile, family) {
  ctx.fillStyle = '#354258'; ctx.fillRect(80, FOOTER_LINE, IMAGE_WIDTH - 160, 1);
  fitText(ctx, profile.demo
    ? 'DEMO ONLY  /  Names, scores and ratings are fabricated. Jackets are procedural; grade and plate badges are official assets.'
    : 'SOURCE  /  piugame.com/my_page/pumbility.php  ·  Official order preserved  ·  Missing values shown as —',
  80, FOOTER_LINE + 34, IMAGE_WIDTH - 160, 18, profile.demo ? '#ffb88c' : COLORS.muted, 400, family);
  fitText(ctx, `UPDATED  /  ${profile.updatedAt ?? 'Not provided by source'}`, 80, FOOTER_LINE + 63, 1450, 17, '#6d809b', 400, family);
  ctx.textAlign = 'right';
  fitText(ctx, 'PIU BEST50  /  COMMUNITY TOOL  ·  NOT AFFILIATED WITH ANDAMIRO', IMAGE_WIDTH - 80, FOOTER_LINE + 63, 1120, 15, '#6d809b', 400, family);
  ctx.textAlign = 'left';
}

/**
 * Render an original 5-column × 10-row Best50 PNG.
 *
 * Official grade and plate images are read only from the bundled asset
 * manifest. Other image reads require the caller's options.loadImage(source),
 * which may return a canvas Image/Canvas or image bytes. Failed jacket/avatar
 * loads fall back to original procedural artwork.
 * options.fontFamily selects an already installed/registered font family.
 *
 * @param {object} input Normalized profile or the same plain JSON shape.
 * @param {{loadImage?:Function,onImageError?:Function,fontFamily?:string}} options
 * @returns {Promise<Buffer>}
 */
export async function renderBest50(input, options = {}) {
  const profile = normalizeProfile(input);
  const family = typeof options.fontFamily === 'string' && options.fontFamily.trim()
    ? options.fontFamily : DEFAULT_FONT;
  const [images, badges] = await Promise.all([loadImages(profile, options), loadBadgeImages()]);
  const canvas = createCanvas(IMAGE_WIDTH, IMAGE_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'left';
  drawBackground(ctx);
  drawHeader(ctx, profile, images, family);
  for (let slot = 0; slot < GRID_COLUMNS * GRID_ROWS; slot += 1) {
    drawCard(ctx, profile.records[slot], slot, PAGE_MARGIN + (slot % GRID_COLUMNS) * (CARD_WIDTH + GRID_GAP),
      GRID_TOP + Math.floor(slot / GRID_COLUMNS) * (CARD_HEIGHT + GRID_GAP), images, badges, family, profile.demo);
  }
  drawFooter(ctx, profile, family);
  return canvas.encode('png');
}

export default renderBest50;
