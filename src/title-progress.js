import {load} from 'cheerio';
import {normalizeGameIdSelector} from './parser.js';
import {PiuError} from './errors.js';

const TIERS = ['INTERMEDIATE', 'ADVANCED', 'EXPERT'];
const changed = () => new PiuError('PAGE_CHANGED', '未能完整读取 Title 页面的 Single / Double 等级与分数，已停止生成以避免错误进度。');
const numeric = value => {
  const text = String(value).trim().replaceAll(',', '');
  return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
};
const label = (tier, level) => level === null ? tier : `${tier} Lv.${level}`;

function progress(value) {
  const {tier, level = null, score, minimum, nextThreshold = null, nextTitle = null} = value;
  if (!['BEGINNER', ...TIERS, 'MASTER'].includes(tier) ||
      (TIERS.includes(tier) ? !Number.isInteger(level) || level < 1 || level > 10 : level !== null) ||
      !Number.isFinite(minimum) || minimum < 0 ||
      (score !== null && (!Number.isFinite(score) || score < minimum))) throw changed();
  const maxed = tier === 'MASTER';
  if (!maxed && (score === null || !Number.isFinite(nextThreshold) || nextThreshold <= minimum || score >= nextThreshold || typeof nextTitle !== 'string' || !nextTitle.trim())) throw changed();
  return {title: label(tier, level), tier, level, score, minimum,
    nextThreshold: maxed ? null : nextThreshold, nextTitle: maxed ? null : nextTitle.slice(0, 64),
    percent: maxed ? 100 : (score - minimum) / (nextThreshold - minimum) * 100, maxed};
}

/** Rendering also accepts offline JSON; missing or invalid progress stays missing. */
export function normalizeTitleProgress(input) {
  const result = {};
  for (const mode of ['single', 'double']) {
    try { result[mode] = progress(input?.[mode] ?? {}); }
    catch { result[mode] = null; }
  }
  return result;
}

/** Read live thresholds and scores. Legacy titles and equipped cosmetic titles
 * are deliberately excluded from this Pumbility progression. */
export function parseTitleProgress(html) {
  const $ = load(html);
  if ($('form#login_fs, input[name="mb_password"]').length && !$('.subProfile_wrap').length) {
    throw new PiuError('AUTH_REQUIRED', '登录已失效，请重新扫码或导入该账号 Cookie。');
  }
  const playerName = normalizeGameIdSelector($('.subProfile_wrap .name_w .t2').first().text());
  if (!playerName || !$('.data_title_wrap .data_titleList2').length) throw changed();
  const modes = {single: [], double: []};
  $('.data_titleList2 > li').each((_, element) => {
    const row = $(element);
    const title = (row.attr('data-name') ?? row.find('.txt_w .t1 .txt').first().text()).replace(/\s+/g, ' ').trim();
    const leveled = /^\[([SD])\]\s*(INTERMEDIATE|ADVANCED|EXPERT)\s+LV\.?\s*(10|[1-9])$/i.exec(title);
    const master = /^(SINGLE|DOUBLE)\s+MASTER$/i.exec(title);
    if (!leveled && !master) return;
    const mode = leveled ? (leveled[1].toUpperCase() === 'S' ? 'single' : 'double') : master[1].toLowerCase();
    const condition = row.find('.txt_w2 .t3:not(.require-count) .txt').first().text().trim();
    const requirement = /^(Single|Double)\s+Pumbility\s+of\s+([\d,]+(?:\.\d+)?)\s*\+$/i.exec(condition);
    if (!requirement || requirement[1].toLowerCase() !== mode) throw changed();
    const threshold = numeric(requirement[2]);
    if (!Number.isFinite(threshold) || threshold <= 0) throw changed();
    let score = null;
    const counter = row.find('.require-count .txt').text().trim();
    if (counter) {
      const match = /^\[\s*([\d,]+(?:\.\d+)?)\s*\/\s*([\d,]+(?:\.\d+)?)\s*\]$/.exec(counter);
      if (!match || numeric(match[2]) !== threshold) throw changed();
      score = numeric(match[1]);
      if (!Number.isFinite(score)) throw changed();
    }
    const tier = master ? 'MASTER' : leveled[2].toUpperCase();
    const level = master ? null : Number(leveled[3]);
    modes[mode].push({tier, level, threshold, score, owned: row.hasClass('have'), order: master ? 30 : TIERS.indexOf(tier) * 10 + level - 1});
  });
  const result = {playerName};
  for (const mode of ['single', 'double']) {
    const rows = modes[mode].sort((a, b) => a.order - b.order);
    if (rows.length !== 31 || rows.some((row, index) => row.order !== index || (index > 0 && row.threshold <= rows[index - 1].threshold))) throw changed();
    const scores = rows.filter(row => row.score !== null).map(row => row.score);
    if (scores.some(score => score !== scores[0])) throw changed();
    const score = scores[0] ?? null;
    if (score === null) {
      // The official page omits exact counters once all titles are unlocked.
      // Show the verified MASTER lower bound instead of inventing a score.
      if (!rows.every(row => row.owned)) throw changed();
      result[mode] = progress({tier:'MASTER', level:null, score:null, minimum:rows.at(-1).threshold});
      continue;
    }
    const current = rows.findLast(row => row.threshold <= score);
    const next = rows.find(row => row.threshold > score);
    result[mode] = progress({tier:current?.tier ?? 'BEGINNER', level:current?.level ?? null,
      score, minimum:current?.threshold ?? 0, nextThreshold:next?.threshold ?? null,
      nextTitle:next ? label(next.tier, next.level) : null});
  }
  return result;
}
