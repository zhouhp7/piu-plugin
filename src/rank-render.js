import { createCanvas } from '@napi-rs/canvas';

export const RANK_IMAGE_WIDTH = 1800;
const FONT = 'Arial, "Noto Sans CJK SC", "Noto Sans", "Microsoft YaHei", "PingFang SC", sans-serif';
const INK = '#172333';
const MUTED = '#627185';
const BLUE = '#195fc1';
const RED = '#c53e49';
const GREEN = '#168067';
const DASH = '—';
const MARGIN = 32;
const TABLE_TOP = 226;
const HEADER_HEIGHT = 60;
const COLUMNS = [
  { key: 'name', title: 'GAME ID（名称#标签）', width: 468 },
  { key: 'score', title: 'PUMBILITY', width: 220 },
  { key: 'scoreDelta', title: '分数变动', width: 150 },
  { key: 'worldRank', title: '世界名次', width: 136 },
  { key: 'worldDelta', title: '变动', width: 112 },
  { key: 'countryRank', title: '关注内名次*', width: 142 },
  { key: 'countryDelta', title: '变动', width: 112 },
  { key: 'lastPlayedAt', title: '最后游玩时间（GMT+8）', width: 396 },
];
const TABLE_WIDTH = COLUMNS.reduce((sum, column) => sum + column.width, 0);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

/** The board exposes no nationality; use the followed-list scope by default. */
export function formatRankBasis(rankBasis = 'followed') {
  if (rankBasis === 'country') return {
    heading: '中国名次*',
    footnote: '* 中国名次按全球前 1000 中的中国玩家计算，不代表全部中国玩家名次。',
  };
  if (rankBasis !== 'followed') throw new TypeError('rankBasis must be followed or country');
  return {
    heading: '关注内名次*',
    footnote: '* 关注内名次在本次关注名单中、且进入全球前 1000 的玩家之间计算。',
  };
}

function scopedRank(entry, rankBasis) {
  if (!entry) return null;
  return rankBasis === 'followed' && Object.hasOwn(entry, 'followRank') ? entry.followRank : entry.countryRank;
}

function dateLabel(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value ?? ''));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : String(value || '日期未知');
}

/** ISO snapshot timestamps are displayed in the fixed GMT+8 reporting zone. */
export function formatRankCaptureTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 19)}`;
}

function lastPlayedLabel(value) {
  if (!value) return DASH;
  // PIU's unzoned source text is already a website display value. Do not
  // silently interpret its timezone as GMT+8 or the server's local zone.
  if (typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return formatRankCaptureTime(value);
  return String(value).replace('T', ' ').trim();
}

function delta(value, digits = 0) {
  if (!isNumber(value)) return { text: DASH, color: MUTED };
  const rounded = Number(value.toFixed(digits));
  if (!rounded) return { text: DASH, color: MUTED };
  return { text: `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}`, color: rounded > 0 ? BLUE : RED };
}

function entryState(row) {
  return row.status === 'BACK' ? 'BACK' : 'NEW';
}

/**
 * Convert comparison values without treating an absent rank or score as zero.
 * Exported so callers/tests can inspect the same semantics used in the image.
 */
export function formatRankRow(row, hasPreviousSnapshot = true, rankBasis = 'followed') {
  const current = row.current ?? null;
  const previous = row.previous ?? null;
  const rawName = String(row.gameId ?? row.playerName ?? row.playerKey ?? '未知玩家');
  const tag = row.tag ? String(row.tag).replace(/^#?/, '#') : DASH;
  const name = tag !== DASH && rawName.endsWith(tag) ? rawName.slice(0, -tag.length).trimEnd() : rawName;
  const currentRank = scopedRank(current, rankBasis);
  const previousRank = scopedRank(previous, rankBasis);
  const result = {
    name, tag, identifier: tag === DASH ? name : `${name}${tag}`,
    score: current && isNumber(current.score) ? current.score.toFixed(2) : DASH,
    worldRank: current && isNumber(current.worldRank) ? String(current.worldRank) : '未上榜',
    countryRank: isNumber(currentRank) ? String(currentRank) : DASH,
    lastPlayedAt: lastPlayedLabel(current?.lastPlayedAt ?? previous?.lastPlayedAt),
    scoreDelta: { text: DASH, color: MUTED },
    worldDelta: { text: DASH, color: MUTED },
    countryDelta: { text: DASH, color: MUTED },
    status: current ? 'IN' : previous ? 'OUT' : 'UNRANKED',
    previousLastPlayed: !current && Boolean(previous?.lastPlayedAt),
  };
  if (!hasPreviousSnapshot) return result;
  if (current && previous) {
    result.scoreDelta = delta(isNumber(current.score) && isNumber(previous.score) ? current.score - previous.score : null, 2);
    result.worldDelta = delta(isNumber(current.worldRank) && isNumber(previous.worldRank) ? previous.worldRank - current.worldRank : null);
    result.countryDelta = delta(isNumber(currentRank) && isNumber(previousRank) ? previousRank - currentRank : null);
  } else if (current && !previous) {
    const marker = { text: entryState(row), color: GREEN };
    result.scoreDelta = marker;
    result.worldDelta = marker;
    if (isNumber(currentRank)) result.countryDelta = marker;
  } else if (!current && previous) {
    const marker = { text: 'OUT', color: RED };
    result.scoreDelta = marker;
    result.worldDelta = marker;
    if (isNumber(previousRank)) result.countryDelta = marker;
  }
  return result;
}

function font(ctx, size, weight = 400) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textBaseline = 'middle';
}

function text(ctx, value, x, y, maxWidth, size = 25, color = INK, weight = 400, align = 'center') {
  const output = String(value);
  font(ctx, size, weight);
  while (ctx.measureText(output).width > maxWidth && size > 11) font(ctx, --size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(output, x, y, maxWidth);
}

function wrapName(ctx, name) {
  const width = COLUMNS[0].width - 36;
  let size = 25;
  font(ctx, size, 600);
  if (ctx.measureText(name).width <= width) return { lines: [name], size, height: 52 };
  size = 21;
  font(ctx, size, 600);
  const lines = [];
  let line = '';
  for (const char of name) {
    if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = ''; }
    line += char;
  }
  if (line) lines.push(line);
  return { lines, size, height: Math.max(58, lines.length * 26 + 12) };
}

function sourceLabel(snapshot) {
  if (!snapshot) return '缺少历史快照';
  const kind = ['scheduled', 'daily', 'schedule'].includes(snapshot.kind)
    ? '每日 01:00 快照' : snapshot.kind === 'catchup' ? '补抓快照（非准点）' : snapshot.kind ? '即时快照' : '快照';
  return `${dateLabel(snapshot.date)}（${kind}）`;
}

function rowOrder(left, right) {
  const currentLeft = isNumber(left.current?.worldRank) ? left.current.worldRank : Infinity;
  const currentRight = isNumber(right.current?.worldRank) ? right.current.worldRank : Infinity;
  if (currentLeft !== currentRight) return currentLeft - currentRight;
  const previousLeft = isNumber(left.previous?.worldRank) ? left.previous.worldRank : Infinity;
  const previousRight = isNumber(right.previous?.worldRank) ? right.previous.worldRank : Infinity;
  return previousLeft - previousRight || String(left.gameId ?? left.playerKey).localeCompare(String(right.gameId ?? right.playerKey));
}

/**
 * Render a self-contained table PNG with no network/image asset reads.
 * Missing snapshots and players outside the global top 1000 stay missing;
 * only real paired observations produce numeric changes.
 * @returns {Promise<Buffer>}
 */
export async function renderRankComparison({ title, current, previous = null, rows = [], scopeLabel, rankBasis = 'followed' } = {}) {
  if (!current || typeof current !== 'object') throw new TypeError('current snapshot metadata is required');
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const basis = formatRankBasis(rankBasis);
  const rawSourceTime = rows.some(row => {
    const value = row.current?.lastPlayedAt ?? row.previous?.lastPlayedAt;
    return value && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  });
  const columns = COLUMNS.map(column => ({...column,
    ...(column.key === 'countryRank' ? {title: basis.heading} : {}),
    ...(column.key === 'lastPlayedAt' && rawSourceTime ? {title: '最后游玩时间*'} : {}),
  }));
  const measuring = createCanvas(1, 1).getContext('2d');
  const orderedRows = [...rows].sort(rowOrder);
  const prepared = orderedRows.map(row => {
    const display = formatRankRow(row, Boolean(previous), rankBasis);
    return { row, display, name: wrapName(measuring, display.identifier) };
  });
  const bodyHeight = prepared.length ? prepared.reduce((sum, item) => sum + item.name.height, 0) : 98;
  const footerLines = [
    basis.footnote,
    '正数表示进步，负数表示下降；NEW 相对基准日新上榜 · BACK 再次上榜 · OUT 本次未进入前 1000。',
    previous ? '— 表示无变化或无可比较数据；离榜行的最后游玩时间取自前次快照。' : '缺少历史快照：仅展示当前数据，所有变动留空；不会推算或补造过去成绩。',
  ];
  if (rawSourceTime) footerLines.push('* 带时区数据统一显示为 GMT+8；未标明时区的数据保留官网原文。');
  const tableBottom = TABLE_TOP + HEADER_HEIGHT + bodyHeight;
  const height = tableBottom + 54 + footerLines.length * 32;
  const canvas = createCanvas(RANK_IMAGE_WIDTH, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f2f5f8'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(MARGIN, 24, TABLE_WIDTH, 180);
  ctx.fillStyle = '#163b66'; ctx.fillRect(MARGIN, 24, 7, 180);
  text(ctx, title || 'PIU PHOENIX 2 · PUMBILITY 关注榜', MARGIN + 26, 61, 1280, 34, INK, 700, 'left');
  text(ctx, scopeLabel || '全球前 1000', RANK_IMAGE_WIDTH - MARGIN - 22, 60, 350, 23, MUTED, 600, 'right');
  text(ctx, `本次：${sourceLabel(current)}    对比：${sourceLabel(previous)}`, MARGIN + 26, 105, TABLE_WIDTH - 52, 24, INK, 400, 'left');
  text(ctx, `实际采集：${formatRankCaptureTime(current.capturedAt)}（GMT+8）${previous ? `   /   前次：${formatRankCaptureTime(previous.capturedAt)}` : ''}`, MARGIN + 26, 143, TABLE_WIDTH - 52, 22, MUTED, 400, 'left');
  const sourceUpdated = current.sourceUpdatedAt ? `   ·   官网更新时间：${lastPlayedLabel(current.sourceUpdatedAt)}` : '';
  text(ctx, `关注 ${rows.length} 位 · 本次上榜 ${rows.filter(row => row.current).length} 位${sourceUpdated}`, MARGIN + 26, 177, TABLE_WIDTH - 52, 21, MUTED, 400, 'left');

  ctx.fillStyle = '#183a60'; ctx.fillRect(MARGIN, TABLE_TOP, TABLE_WIDTH, HEADER_HEIGHT);
  let x = MARGIN;
  for (const column of columns) {
    text(ctx, column.title, x + column.width / 2, TABLE_TOP + HEADER_HEIGHT / 2, column.width - 16, 23, '#ffffff', 600);
    x += column.width;
  }
  let y = TABLE_TOP + HEADER_HEIGHT;
  let rankedIndex = 0;
  for (let index = 0; index < prepared.length; index += 1) {
    const { row, display, name } = prepared[index];
    const center = y + name.height / 2;
    const ranked = Boolean(row.current);
    const highlight = ranked && rankedIndex < 3 ? ['#fff1ba', '#edf0f4', '#f8e3cb'][rankedIndex] : null;
    if (ranked) rankedIndex += 1;
    ctx.fillStyle = index % 2 ? '#f7f9fc' : '#ffffff';
    ctx.fillRect(MARGIN, y, TABLE_WIDTH, name.height);
    if (highlight) { ctx.fillStyle = highlight; ctx.fillRect(MARGIN, y, COLUMNS[0].width, name.height); }
    if (!row.current) { ctx.fillStyle = '#f1f3f6'; ctx.fillRect(MARGIN, y, TABLE_WIDTH, name.height); }
    x = MARGIN;
    for (const column of columns) {
      if (column.key === 'name') {
        name.lines.forEach((line, index) => text(ctx, line, x + 18, center + (index - (name.lines.length - 1) / 2) * 26, column.width - 36, name.size, row.current ? INK : MUTED, 600, 'left'));
      } else if (column.key.endsWith('Delta')) {
        const value = display[column.key];
        text(ctx, value.text, x + column.width / 2, center, column.width - 16, 25, value.color, 600);
      } else {
        const size = column.key === 'score' ? 29 : column.key === 'lastPlayedAt' ? 23 : 26;
        const lastPlayed = column.key === 'lastPlayedAt' && display.previousLastPlayed ? `前次：${display.lastPlayedAt}` : display[column.key];
        text(ctx, lastPlayed, x + column.width / 2, center, column.width - 18, size, row.current ? INK : MUTED, column.key === 'score' ? 600 : 400);
      }
      x += column.width;
    }
    y += name.height;
    ctx.strokeStyle = '#bdc7d3'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(MARGIN, y + 0.5); ctx.lineTo(MARGIN + TABLE_WIDTH, y + 0.5); ctx.stroke();
  }
  if (!prepared.length) text(ctx, '尚未关注玩家 · 使用 #piu follow 名称#四位标签 添加', RANK_IMAGE_WIDTH / 2, y + 49, TABLE_WIDTH - 80, 26, MUTED);
  ctx.strokeStyle = '#aab7c7'; ctx.lineWidth = 1;
  x = MARGIN;
  for (const column of columns) {
    ctx.beginPath(); ctx.moveTo(x + 0.5, TABLE_TOP); ctx.lineTo(x + 0.5, tableBottom); ctx.stroke();
    x += column.width;
  }
  ctx.strokeRect(MARGIN + 0.5, TABLE_TOP + 0.5, TABLE_WIDTH, tableBottom - TABLE_TOP);
  footerLines.forEach((line, index) => text(ctx, line, MARGIN + 2, tableBottom + 34 + index * 32, TABLE_WIDTH - 4, 21, MUTED, 400, 'left'));
  return canvas.toBuffer('image/png');
}
