import { createCanvas, loadImage as decodeImage } from '@napi-rs/canvas';
import { loadBadgeAssets } from './assets.js';
import { normalizeProfile } from './model.js';
import { formatShanghaiTime } from './time-format.js';
import {encodeOutput, scaledDimension} from './image-output.js';
import {drawProfileMeta} from './profile-meta-render.js';

export const CARD_WIDTH = 600;
export const CARD_HEIGHT = 260;
const GRID_COLUMNS = 5;
const GRID_ROWS = 10;
const GRID_GAP = 20;
const PAGE_MARGIN = 80;
const GRID_TOP = 264;
const GRID_BOTTOM = GRID_TOP + CARD_HEIGHT * GRID_ROWS + GRID_GAP * (GRID_ROWS - 1);
const FOOTER_LINE = GRID_BOTTOM + 34;
const LAYOUT_WIDTH = PAGE_MARGIN * 2 + CARD_WIDTH * GRID_COLUMNS + GRID_GAP * (GRID_COLUMNS - 1);
export const TITLE_PANEL_HEIGHT = 172;
const PROFILE_META_HEIGHT = 128;
const RECENT_LAYOUT_HEIGHT = FOOTER_LINE + 84 + PROFILE_META_HEIGHT;
const LAYOUT_HEIGHT = RECENT_LAYOUT_HEIGHT + TITLE_PANEL_HEIGHT;
export const IMAGE_WIDTH = scaledDimension(LAYOUT_WIDTH);
export const IMAGE_HEIGHT = scaledDimension(LAYOUT_HEIGHT);
export const RECENT_IMAGE_HEIGHT = scaledDimension(RECENT_LAYOUT_HEIGHT);

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

function formatNumber(value, digits = 0, useGrouping = true) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, useGrouping }).format(value);
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

function drawBackground(ctx, height) {
  const bg = ctx.createLinearGradient(0, 0, LAYOUT_WIDTH, height);
  bg.addColorStop(0, '#111b30'); bg.addColorStop(0.46, '#0a1020'); bg.addColorStop(1, '#0a0e1a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, LAYOUT_WIDTH, height);
  const glow = ctx.createRadialGradient(1950, 110, 0, 1950, 110, 880);
  glow.addColorStop(0, '#ea41831b'); glow.addColorStop(1, '#ea418300');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, LAYOUT_WIDTH, 1000);
  const cyanGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 950);
  cyanGlow.addColorStop(0, '#22d9dd12'); cyanGlow.addColorStop(1, '#22d9dd00');
  ctx.fillStyle = cyanGlow; ctx.fillRect(0, 0, 1100, 1100);
  ctx.strokeStyle = '#ffffff03'; ctx.lineWidth = 1;
  for (let x = 0; x <= LAYOUT_WIDTH; x += 44) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y <= height; y += 44) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(LAYOUT_WIDTH, y); ctx.stroke(); }
  ctx.fillStyle = COLORS.cyan; ctx.fillRect(80, 0, 440, 6);
  ctx.fillStyle = COLORS.pink; ctx.fillRect(532, 0, 110, 6);
}

function drawTitleProgress(ctx, profile, family) {
  const gap = 32, width = (LAYOUT_WIDTH - PAGE_MARGIN * 2 - gap) / 2;
  const tierColors = {BEGINNER:COLORS.muted, INTERMEDIATE:'#ffca28', ADVANCED:COLORS.cyan, EXPERT:'#bd9aff', MASTER:'#ff83bd'};
  for (const [index, mode] of ['single', 'double'].entries()) {
    const x = PAGE_MARGIN + index * (width + gap), y = GRID_TOP + PROFILE_META_HEIGHT;
    const value = profile.titleProgress[mode];
    const color = tierColors[value?.tier] ?? COLORS.muted;
    panel(ctx, x, y, width, 142, 16, '#152035', '#35465e');
    ctx.fillStyle = LEVEL_COLORS[mode === 'single' ? 'S' : 'D'];
    ctx.beginPath(); ctx.arc(x + 28, y + 32, 7, 0, Math.PI * 2); ctx.fill();
    fitText(ctx, mode.toUpperCase(), x + 45, y + 41, 170, 26, COLORS.light, 700, family);
    fitText(ctx, value?.title ?? 'TITLE UNAVAILABLE', x + 216, y + 41, width - 520, 30, color, 700, family);
    ctx.textAlign = 'right';
    // Truncating avoids showing 100% before the next title is actually reached.
    const percent = value ? `${Math.floor(value.percent * 10) / 10}%` : '—';
    fitText(ctx, value?.maxed ? '100% · MAX' : percent, x + width - 24, y + 41, 240, 28, color, 700, family);
    ctx.textAlign = 'left';
    const score = !value ? '—' : value.score === null ? `≥ ${formatNumber(value.minimum, 2)}` : formatNumber(value.score, 2);
    const next = value?.nextThreshold === null ? '' : ` / ${formatNumber(value?.nextThreshold, 2)}`;
    fitText(ctx, `SCORE  ${score}${value ? next : ''}`, x + 24, y + 80, width / 2 - 24, 24, COLORS.muted, 400, family);
    ctx.textAlign = 'right';
    fitText(ctx, value?.maxed ? 'HIGHEST TITLE REACHED' : value?.nextTitle ? `NEXT  ${value.nextTitle}` : 'Title page data unavailable', x + width - 24, y + 80, width / 2 - 24, 23, COLORS.muted, 400, family);
    ctx.textAlign = 'left';
    const trackX = x + 24, trackY = y + 102, trackWidth = width - 48, trackHeight = 18;
    panel(ctx, trackX, trackY, trackWidth, trackHeight, 9, '#263247');
    const filled = trackWidth * (value?.percent ?? 0) / 100;
    if (filled > 0) panel(ctx, trackX, trackY, filled, trackHeight, Math.min(9, filled / 2), color);
  }
}

function drawHeader(ctx, profile, images, family) {
  const recent = profile.kind === 'recent';
  fitText(ctx, recent ? 'PIU  /  RECENTLY PLAYED' : 'PIU  /  PERSONAL PERFORMANCE', 80, 67, 1200, 23, COLORS.cyan, 700, family);
  ctx.textAlign = 'right';
  fitText(ctx, profile.demo ? 'FABRICATED DEMO DATA' : recent ? 'PIUGAME.COM  /  RECENTLY PLAYED' : 'PIUGAME.COM  /  MY PUMBILITY', LAYOUT_WIDTH - 80, 67, 850, 21,
    profile.demo ? '#ffb88c' : COLORS.muted, 700, family);
  ctx.textAlign = 'left';
  fitText(ctx, recent ? 'RECENT' : 'PUMBILITY', 76, 185, 1130, 90, COLORS.light, 900, family);
  fitText(ctx, recent ? '50 PLAYS' : 'BEST 50', recent ? 530 : 706, 185, recent ? 580 : 1000, 90, COLORS.cyan, 900, family);

  const infoX = 1150;
  const gradient = ctx.createLinearGradient(infoX, 84, LAYOUT_WIDTH - 80, 212);
  gradient.addColorStop(0, '#1a2a40'); gradient.addColorStop(1, '#171e32');
  panel(ctx, infoX, 84, LAYOUT_WIDTH - infoX - 80, 128, 18, gradient, '#40536b');
  ctx.fillStyle = COLORS.cyan; ctx.fillRect(infoX, 108, 4, 80);
  if (!imageCover(ctx, images.get(profile.avatar), 1170, 115, 72, 72, 16)) {
    panel(ctx, 1170, 115, 72, 72, 16, '#273f53', '#4c7182');
    arrow(ctx, 1206, 151, 34, Math.PI / 4, COLORS.cyan);
  }
  const totalX = profile.ranking ? 2470 : 2760;
  const totalWidth = profile.ranking ? 350 : 400;
  heroText(ctx, profile.playerName, 1270, 185, totalX - 1344, COLORS.light, family);

  ctx.strokeStyle = '#42546a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(totalX - 42, 114); ctx.lineTo(totalX - 42, 194); ctx.stroke();
  const showCount = recent && profile.pumbility === null;
  fitText(ctx, showCount ? 'RECENT RECORDS' : 'TOTAL PUMBILITY', totalX, 106, totalWidth, 17, COLORS.muted, 700, family);
  heroText(ctx, formatNumber(showCount ? profile.records.length : profile.pumbility, 2, false), totalX - 4, 185, totalWidth, COLORS.cyan, family);
  if (profile.ranking) {
    const rankingX = 2900, rankingWidth = LAYOUT_WIDTH - 80 - rankingX;
    ctx.beginPath(); ctx.moveTo(rankingX - 40, 114); ctx.lineTo(rankingX - 40, 194); ctx.stroke();
    fitText(ctx, 'WORLD RANK', rankingX, 106, rankingWidth, 17, COLORS.muted, 700, family);
    const rank = /^\d[\d,]*$/.test(profile.ranking) ? `#${profile.ranking}` : profile.ranking;
    heroText(ctx, rank, rankingX - 4, 185, rankingWidth, COLORS.light, family);
  }

  ctx.textAlign = 'right';
  fitText(ctx, `${profile.records.length} / 50 RECORDS`, LAYOUT_WIDTH - 455, 237, 600, 18, COLORS.muted, 400, family);
  ctx.textAlign = 'left';
  for (const [offset, mode, label] of [[386, 'S', 'SINGLE'], [207, 'D', 'DOUBLE']]) {
    ctx.fillStyle = LEVEL_COLORS[mode];
    ctx.beginPath(); ctx.arc(LAYOUT_WIDTH - offset, 230, 9, 0, Math.PI * 2); ctx.fill();
    fitText(ctx, label, LAYOUT_WIDTH - offset + 18, 237, 132, 18, COLORS.muted, 400, family);
  }
}

function heroText(ctx, value, x, y, maxWidth, color, family) {
  let size = 90;
  font(ctx, size, 900, family);
  while (ctx.measureText(String(value)).width > maxWidth && size > 36) font(ctx, --size, 900, family);
  ctx.fillStyle = color;
  ctx.fillText(String(value), x, y, maxWidth);
}

function drawRating(ctx, value, x, y, maxWidth, color, family, useGrouping = true) {
  const output = formatNumber(value, 3, useGrouping);
  let size = 80;
  font(ctx, size, 700, family);
  while (ctx.measureText(output).width > maxWidth && size > 32) font(ctx, --size, 700, family);
  ctx.fillStyle = color;
  ctx.fillText(output, x, y, maxWidth);
  return Math.min(maxWidth, ctx.measureText(output).width);
}

function drawLevel(ctx, record, centerX, centerY, family) {
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `900 42px ${family}`;
  ctx.fillStyle = ['S','SP'].includes(record.mode) ? '#ff6676' : ['D','DP'].includes(record.mode) ? '#48d791' : '#a7b7cc';
  ctx.fillText(formatNumber(record.level), centerX, centerY + 1, 62);
  ctx.restore();
}

function drawCard(ctx, record, slot, x, y, images, badges, family, isDemo, recent) {
  const w = CARD_WIDTH; const h = CARD_HEIGHT;
  if (!record) {
    panel(ctx, x, y, w, h, 16, '#101827', '#243044');
    fitText(ctx, `#${String(slot + 1).padStart(2, '0')}`, x + 18, y + 33, 100, 20, '#415169', 700, family);
    ctx.textAlign = 'center';
    fitText(ctx, 'NO RECORD', x + w / 2, y + h / 2 + 8, w - 30, 23, '#617188', 700, family);
    fitText(ctx, 'Not available on the source page', x + w / 2, y + h / 2 + 38, w - 35, 16, '#526077', 400, family);
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

  const jacketSize = h - 24;
  const detailsX = x + jacketSize + 24;
  const detailsWidth = w - (detailsX - x) - 12;
  if (!imageCover(ctx, images.get(record.jacket), x + 12, y + 12, jacketSize, jacketSize, 12)) {
    placeholder(ctx, x + 12, y + 12, jacketSize, record.title, isDemo, family);
  }

  fitText(ctx, `#${String(record.rank).padStart(2, '0')} ${record.title}`,
    detailsX, y + 43, detailsWidth, 24, COLORS.light, 700, family);
  ctx.strokeStyle = '#465870'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(detailsX, y + 60); ctx.lineTo(detailsX + detailsWidth, y + 60); ctx.stroke();
  if (recent && record.stageBreak) {
    fitText(ctx, 'STAGE BREAK', detailsX, y + 133, detailsWidth, 33, '#ff8a94', 700, family);
  } else {
    drawRating(ctx, recent ? record.score : record.rating, detailsX - 2, y + (recent ? 137 : 150), detailsWidth - 4, accent, family, !recent);
  }
  if (recent) fitText(ctx, formatShanghaiTime(record.playedAt), detailsX, y + 165, detailsWidth, 16, COLORS.muted, 400, family);

  const badgesY = y + h - 84;
  const badgeBackground = ctx.createLinearGradient(detailsX, badgesY, detailsX + detailsWidth, badgesY + 72);
  badgeBackground.addColorStop(0, '#293d57'); badgeBackground.addColorStop(1, '#223047');
  panel(ctx, detailsX, badgesY, detailsWidth, 72, 12, badgeBackground, '#3b526f');
  const grade = record.grade.toUpperCase();
  const gradeKey = record.failed ? `X_${grade}` : grade;
  const gradeImage = badges.grades.get(gradeKey) ?? badges.grades.get(record.gradeCode?.toUpperCase()) ?? badges.grades.get(grade);
  const plateImage = badges.plates.get(record.plate?.toUpperCase());
  // Fixed slots keep Grade, Plate and level aligned regardless of score width.
  const gradeX = detailsX + 12;
  const plateX = detailsX + 128;
  if (!imageContain(ctx, gradeImage, gradeX, badgesY + 4, 108, 64)) {
    fitText(ctx, '—', gradeX + 42, badgesY + 45, 48, 25, '#c1d1e6', 700, family);
  }
  if (!imageContain(ctx, plateImage, plateX, badgesY + 9, 108, 54)) {
    fitText(ctx, '—', plateX + 42, badgesY + 45, 48, 25, '#c1d1e6', 700, family);
  }
  drawLevel(ctx, record, detailsX + detailsWidth - 38, badgesY + 36, family);
}

function drawFooter(ctx, profile, family, offset) {
  const recent = profile.kind === 'recent';
  const footerLine = FOOTER_LINE + offset;
  ctx.fillStyle = '#354258'; ctx.fillRect(80, footerLine, LAYOUT_WIDTH - 160, 1);
  fitText(ctx, profile.demo
    ? 'DEMO ONLY  /  Names, scores and ratings are fabricated. Jackets are procedural; grade and plate badges are official assets.'
    : recent
      ? 'SOURCE  /  piugame.com/my_page/recently_played.php  ·  Game scores  ·  Newest first  ·  Times: GMT+8'
      : 'SOURCE  /  piugame.com/my_page/pumbility.php + title.php  ·  Official order preserved  ·  Title progress within the current level',
  80, footerLine + 34, LAYOUT_WIDTH - 160, 18, profile.demo ? '#ffb88c' : COLORS.muted, 400, family);
  fitText(ctx, `UPDATE TIME  /  ${formatShanghaiTime(profile.updatedAt)}`, 80, footerLine + 63, 1450, 17, '#6d809b', 400, family);
  ctx.textAlign = 'right';
  fitText(ctx, `PIU ${recent ? 'RECENT' : 'BEST50'}  /  COMMUNITY TOOL  ·  NOT AFFILIATED WITH ANDAMIRO`, LAYOUT_WIDTH - 80, footerLine + 63, 1120, 15, '#6d809b', 400, family);
  ctx.textAlign = 'left';
}

/**
 * Render a 5-column × 10-row Best50 JPEG at two-thirds layout size.
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
  const offset = profile.kind === 'recent' ? 0 : TITLE_PANEL_HEIGHT;
  const canvas = createCanvas(LAYOUT_WIDTH, RECENT_LAYOUT_HEIGHT + offset);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'left';
  drawBackground(ctx, canvas.height);
  drawHeader(ctx, profile, images, family);
  drawProfileMeta(ctx,profile,{x:PAGE_MARGIN,y:GRID_TOP,width:LAYOUT_WIDTH-PAGE_MARGIN*2});
  if (offset) drawTitleProgress(ctx, profile, family);
  for (let slot = 0; slot < GRID_COLUMNS * GRID_ROWS; slot += 1) {
    drawCard(ctx, profile.records[slot], slot, PAGE_MARGIN + (slot % GRID_COLUMNS) * (CARD_WIDTH + GRID_GAP),
      GRID_TOP + PROFILE_META_HEIGHT + offset + Math.floor(slot / GRID_COLUMNS) * (CARD_HEIGHT + GRID_GAP), images, badges, family, profile.demo, profile.kind === 'recent');
  }
  drawFooter(ctx, profile, family, PROFILE_META_HEIGHT + offset);
  return encodeOutput(canvas);
}

/** Recent plays use raw game scores and preserve repeated charts and play times. */
export function renderRecent(input, options = {}) {
  return renderBest50({...input, kind: 'recent'}, options);
}

export default renderBest50;
