import { load } from 'cheerio';
import { PiuError } from './errors.js';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const numeric = value => {
  const text = clean(value).replace(/,/g, '');
  return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
};

/** Explicit player selectors always include both the name and four-digit tag. */
export function normalizeGameIdSelector(value = '') {
  const query = clean(value).normalize('NFC');
  if (!query) return '';
  const match = /^([^#]+?)\s*#\s*(\d{4})$/.exec(query);
  if (!match || !match[1].trim() || query.length > 160) {
    throw new PiuError('GAME_ID_FORMAT', '请使用完整的 名称#四位标签，例如 ZANTING#9403；不再接受纯名称、纯标签或 uid。');
  }
  return `${match[1].trim()}#${match[2]}`;
}

/** Existing account profiles. This deliberately ignores the separate Game ID rename form. */
export function parseGameIds(html) {
  const $ = load(html);
  const currentName = clean($('.subProfile_wrap .name_w .t2').first().text()).replace(/\s*#\s*/, '#').toUpperCase();
  const gameIds = [];
  const seen = new Set();
  $('#profile_modal input[name="sub_profile"]').each((_, element) => {
    const input = $(element);
    const id = input.attr('value') ?? '';
    const root = input.closest('.in_profile');
    const rawName = clean(root.find('.name_w .t2').first().text()).normalize('NFC');
    const match = /^([^#]+?)\s*#\s*(\d{4})$/.exec(rawName);
    if (!/^\d{1,16}$/.test(id) || !match || seen.has(id)) return;
    const playerName = `${match[1].trim()}#${match[2]}`;
    seen.add(id);
    gameIds.push({id, uid: `uid${gameIds.length + 1}`, playerName, gameId: match[1].trim(), tag: `#${match[2]}`,
      selected: input.is('[checked]') || playerName.replace(/\s*#\s*/, '#').toUpperCase() === currentName});
  });
  return gameIds;
}

export function resolveGameId(gameIds, selector = '') {
  const query = normalizeGameIdSelector(selector);
  if (!query) return gameIds[0] ?? null;
  const fullName = item => normalizeGameIdSelector(item.playerName || `${item.gameId}${item.tag}`);
  const exact = gameIds.filter(item => fullName(item) === query);
  const matches = exact.length ? exact : gameIds.filter(item => fullName(item).toUpperCase() === query.toUpperCase());
  if (matches.length > 1) throw new PiuError('GAME_ID_AMBIGUOUS', `完整 GAME ID 大小写仍有歧义，请使用列表中准确的名称：${matches.map(item => fullName(item)).join('、')}`);
  if (!matches.length) throw new PiuError('GAME_ID_NOT_FOUND', '你的账号中未找到该完整档案，请私聊发送 #piu list 查看 名称#标签。');
  return matches[0];
}
function assetCode(src, folder) {
  const match = new RegExp(`/${folder}/${folder === 'plate' ? '(?:s_)?' : ''}([^/.?#]+)\\.[a-z]+`, 'i').exec(src ?? '');
  return match?.[1]?.toUpperCase().replace(/_(?:PLUS|P)$/, '+') ?? '';
}
function imageUrl(root, baseUrl) {
  const style = root.find('.top-wrap, .profile_img .re').first().attr('style') ?? '';
  const raw = /url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/i.exec(style)?.[1] ??
    root.find('.top-wrap img, .profile_img img').first().attr('src');
  if (!raw) return null;
  try { const url = new URL(raw, baseUrl); if (url.hostname === 'piugame.com') url.hostname = 'www.piugame.com'; return url.protocol === 'https:' ? url.href : null; }
  catch { return null; }
}
function chart(root) {
  const ball = root.find('.stepBall_in').first();
  const src = ball.find('.tw img').first().attr('src') ?? '';
  const code = /\/([^/]+)_text\.(?:png|webp)/i.exec(src)?.[1]?.toUpperCase();
  const mode = {SINGLE:'S', DOUBLE:'D', S:'S', D:'D', SP:'SP', DP:'DP', COOP:'COOP', CO_OP:'COOP'}[code] ?? 'UNKNOWN';
  const digits = ball.find('.numw img').toArray().map(img => /_num_(\d+)\./.exec(ball.find(img).attr('src') ?? '')?.[1] ?? '?').join('');
  return {mode, level: /^\d+$/.test(digits) ? Number(digits) : null};
}

/** Parse the official breakdown, preserving its order and values. No rating formula. */
export function parsePumbility(html, {baseUrl = 'https://www.piugame.com', offset = 0} = {}) {
  const $ = load(html);
  const hasProfile = $('.subProfile_wrap .in_profile, .subProfile_wrap .profile_name').length > 0;
  if ($('form#login_fs, input[name="mb_password"]').length && !hasProfile) {
    throw new PiuError('AUTH_REQUIRED', '登录已失效，请私聊发送 #piu 登录。');
  }
  if (!$('.pumbility_total_wrap').length) {
    throw new PiuError('PAGE_CHANGED', '未识别到 Pumbility 页面；请检查登录状态或更新页面解析器。');
  }
  let pumbility = null;
  $('.pumbility_total_wrap .inn, .pumbility_total_wrap .in_bg1').each((_, el) => {
    const block = $(el);
    if (pumbility === null && /pumbility|pumpbility/i.test(block.find('.t1').first().text())) {
      pumbility = numeric(block.find('.t2').first().text());
    }
  });
  if (pumbility === null) {
    pumbility = numeric($('.pumbility_total_wrap .score, .pumbility_total_wrap .t2').first().text());
  }
  if (pumbility === null) {
    const match = clean($('.pumbility_total_wrap').text()).match(/\d[\d,]*\.\d+|\d[\d,]*/);
    pumbility = match ? numeric(match[0]) : null;
  }
  let entries = $('li').filter((_, el) => $(el).children('.top-wrap').length > 0);
  if (!entries.length) entries = $('.pumblitiySt ul.list > li, .pumblitiySt ul.list2 > li');
  const records = [];
  entries.each((_, el) => {
    const row = $(el);
    const label = clean(row.find('.mid-wrap').first().text());
    const split = label.lastIndexOf(' - ');
    const title = clean(row.find('.profile_name .t1').first().text()) || (split > 0 ? label.slice(0, split) : label);
    if (!title) throw new PiuError('PAGE_CHANGED', '官网成绩卡片结构发生变化，未能读取曲名。');
    const ratingText = row.find('.bottom-wrap .in.score, .bottom-wrap .score, .score .tt').first().text();
    const rating = numeric(ratingText);
    if (rating === null) throw new PiuError('PAGE_CHANGED', '未能读取官网单曲 Pumbility，已停止生成以避免错误数据。');
    const gradeCode = assetCode(row.find('.grade_wrap img, .grade img').first().attr('src'), 'grade');
    const failed = gradeCode.startsWith('X_');
    records.push({rank: numeric(row.find('.num .img_wrap .num .tt').first().text()) ?? offset + records.length + 1,
      title, ...chart(row), rating,
      // The breakdown's .score is Pumbility, not the raw 0–1,000,000 play score.
      score: null,
      grade: failed ? gradeCode.slice(2) : gradeCode, gradeCode, failed,
      plate: assetCode(row.find('.plate img').first().attr('src'), 'plate'),
      jacket: imageUrl(row, baseUrl), playedAt: clean(row.find('.date .tt').first().text()) || null});
  });
  if (pumbility === null || (!records.length && pumbility > 0)) {
    throw new PiuError('PAGE_CHANGED', 'Pumbility 数据不完整，可能是官网改版；请联系管理员更新解析器。');
  }
  const profile = $('.subProfile_wrap').first();
  const rawPlayerName = clean(profile.find('.name_w .t2').first().text()) || clean(profile.find('.profile_name .t2').first().text()) || 'PIU Player';
  const playerName = /#\s*\d{4}$/.test(rawPlayerName) ? normalizeGameIdSelector(rawPlayerName) : rawPlayerName;
  let lastPage = 1;
  $('.board_paging a, .board_paging button').each((_, el) => {
    const node = $(el);
    const match = /[?&]page=(\d+)/.exec((node.attr('href') ?? '') + ' ' + (node.attr('onclick') ?? ''));
    const n = match ? Number(match[1]) : numeric(node.text());
    if (n && n <= 20) lastPage = Math.max(lastPage, n);
  });
  return {playerName, pumbility, ranking: null, updatedAt: new Date().toISOString(),
    source: 'piugame.com', records, lastPage};
}
