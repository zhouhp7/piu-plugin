import {load} from 'cheerio';
import {PiuError} from './errors.js';
import {normalizeGameIdName} from './parser.js';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().normalize('NFC');
const changed = message => new PiuError('RANKING_PAGE_CHANGED', message);
const gameName = value => {
  try { return normalizeGameIdName(value); }
  catch { throw changed('排行榜名称须为 1 至 12 位英文字母或数字，未保存数据。'); }
};

/** Public identity is the complete name and tag, never the four digits alone. */
export function rankingPlayerKey(gameId, tag) {
  const name = gameName(gameId);
  if (typeof tag !== 'string' || !/^#\d{4}$/.test(tag)) {
    throw changed('排行榜名称或四位标签无效，未保存数据。');
  }
  return `game:${name}${tag}`;
}

function number(value) {
  const text = String(value ?? '').replace(/[\s,]/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const result = Number(text);
  return Number.isFinite(result) ? result : null;
}

function rankOf(row) {
  const value = number(row.find('.num .tt').first().text());
  if (Number.isInteger(value) && value > 0) return value;
  const medals = {goldmedal: 1, silvermedal: 2, bronzemedal: 3};
  for (const image of row.find('.num img').toArray()) {
    const src = row.find(image).attr('src') ?? '';
    const stem = /(?:^|\/)(goldmedal|silvermedal|bronzemedal)\.(?:png|webp)(?:[?#].*)?$/i.exec(src)?.[1]?.toLowerCase();
    if (stem) return medals[stem];
  }
  throw changed('排行榜世界名次无法识别，已停止读取以避免错位。');
}

function lastPlay(value) {
  const source = clean(value);
  if (!source || /^[-—]$/.test(source)) return {lastPlayedAt: null, lastPlayedSource: null};
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*\(GMT([+-])(\d{1,2})(?::(\d{2}))?\)$/i.exec(source);
  if (!match) {
    // Keep an unzoned source value as text. It must not acquire the host's time zone.
    return {lastPlayedAt: source, lastPlayedSource: source};
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[8]);
  const offsetMinute = Number(match[9] ?? 0);
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0) || local.getUTCFullYear() !== year ||
      local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) {
    throw changed('排行榜最后游玩时间无效，未保存数据。');
  }
  const sign = match[7] === '+' ? 1 : -1;
  return {lastPlayedAt: new Date(local.getTime() - sign * (offsetHour * 60 + offsetMinute) * 60_000).toISOString(), lastPlayedSource: source};
}

function nextPage($, page) {
  let result = null;
  $('.board_paging a, .board_paging button').each((_, element) => {
    const node = $(element);
    const isNext = node.attr('rel') === 'next' || node.hasClass('next') || node.find('.next').length > 0;
    if (!isNext) return;
    const candidate = /(?:[?&]|\b)page=(\d+)/i.exec(`${node.attr('href') ?? ''} ${node.attr('onclick') ?? ''}`)?.[1];
    if (candidate && Number(candidate) > page && Number(candidate) <= 1000) result = Number(candidate);
  });
  return result;
}

/** Parse every supplied leaderboard row, including rows hidden by the site's load-more UI. */
export function parseRankingPage(html, {page = 1} = {}) {
  if (typeof html !== 'string' || !Number.isInteger(page) || page < 1) throw changed('排行榜页面参数无效。');
  const $ = load(html);
  const rows = $('ul.pumbilitySt > li').filter((_, element) => !$(element).closest('.my_pumblitiy_wrap').length);
  if (!rows.length) {
    if ($('form#login_fs, input[name="mb_password"]').length) {
      throw new PiuError('AUTH_REQUIRED', '排行榜会话已失效，请机器人主人重新完成 #piu ranklogin 登录。');
    }
    throw changed('未识别到全球 Pumbility 排行榜，未保存快照。');
  }
  const keys = new Set();
  let previousRank = 0;
  const entries = rows.toArray().map(element => {
    const row = $(element);
    const gameId = gameName(row.find('.profile_name.pl0').first().text());
    const tag = clean(row.find('.profile_name.st1').first().text());
    const playerKey = rankingPlayerKey(gameId, tag);
    if (keys.has(playerKey)) throw changed(`排行榜重复出现完整档案 ${gameId}${tag}，未保存快照。`);
    keys.add(playerKey);
    const worldRank = rankOf(row);
    if (worldRank < previousRank) throw changed('排行榜名次顺序异常，未保存快照。');
    previousRank = worldRank;
    const score = number(row.find('.score .tt').first().text());
    if (score === null) throw changed(`无法读取 ${gameId}${tag} 的 Pumbility 分数。`);
    return {playerKey, gameId, tag, worldRank, score, country: null,
      ...lastPlay(row.find('.date .tt').first().text())};
  });
  // A daily refresh notice is cadence, not proof of an actual source-update timestamp.
  const sourceUpdatedAt = clean(rows.first().parent('ul.pumbilitySt').attr('data-updated-at')) || null;
  return {entries, nextPage: nextPage($, page), sourceUpdatedAt};
}

/** Report all repeated tags while preserving the distinct complete identities. */
export function auditRanking(entries) {
  if (!Array.isArray(entries)) throw changed('排行榜审计输入无效。');
  const groups = new Map();
  const keys = new Set();
  for (const entry of entries) {
    if (!entry || !/^#\d{4}$/.test(entry.tag ?? '') || !entry.gameId || !entry.playerKey) throw changed('排行榜审计条目无效。');
    const gameId = gameName(entry.gameId), playerKey = rankingPlayerKey(gameId, entry.tag);
    if (keys.has(playerKey)) throw changed('排行榜审计出现重复完整档案，未保存数据。');
    keys.add(playerKey);
    if (!groups.has(entry.tag)) groups.set(entry.tag, []);
    groups.get(entry.tag).push({playerKey, gameId, tag: entry.tag, worldRank: entry.worldRank});
  }
  const duplicateTags = [...groups].filter(([, players]) => players.length > 1)
    .map(([tag, players]) => ({tag, players}));
  return {count: entries.length, duplicateTags, duplicateTagCount: duplicateTags.length,
    affectedPlayers: duplicateTags.reduce((sum, group) => sum + group.players.length, 0)};
}
