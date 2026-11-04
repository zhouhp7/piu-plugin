import {PiuError} from './errors.js';
import {normalizeGameIdSelector} from './parser.js';

export const canonicalPlayer = entry => {
  const value = parseFullPlayer(typeof entry?.gameId === 'string' && typeof entry?.tag === 'string' ? `${entry.gameId}${entry.tag}` : null);
  return `${value.gameId}${value.tag}`;
};

/** Explicit selectors always include both a name and the four-digit tag. */
export function parseFullPlayer(value) {
  let normalized;
  try { normalized = normalizeGameIdSelector(value); }
  catch { throw new PiuError('RANK_ID', '请使用完整的 名称#四位标签，例如 SHAWN#1477；名称限 1 至 12 位英文字母或数字，不接受简称、空格或符号。'); }
  const match = /^([A-Z0-9]{1,12})(#\d{4})$/.exec(normalized);
  if (!match) throw new PiuError('RANK_ID', '请使用完整的 名称#四位标签，例如 SHAWN#1477；名称限 1 至 12 位英文字母或数字。');
  return {gameId:match[1], tag:match[2]};
}

/** Parse batches without allowing whitespace to become part of a player name. */
export function parseFollowBatch(input) {
  if (typeof input !== 'string' || input.length > 2000) throw new PiuError('RANK_ID', '关注参数过长。');
  const tokens = [];
  let current = '', quote = null;
  for (const char of input.trim()) {
    if (quote) { if (char === quote) quote = null; else current += char; }
    else if ((char === '"' || char === "'") && !current) quote = char;
    else if (/\s/.test(char)) { if (current) { tokens.push(current); current = ''; } }
    else current += char;
  }
  if (quote) throw new PiuError('RANK_ID', '名称引号未闭合，请使用完整的 名称#四位标签。');
  if (current) tokens.push(current);
  const combined = [];
  for (let i = 0; i < tokens.length; i++) {
    const next = tokens[i + 1];
    if (!tokens[i].includes('#') && /^#\d{4}$/.test(next ?? '')) combined.push(tokens[i++] + next);
    else combined.push(tokens[i]);
  }
  if (!combined.length || combined.length > 100) throw new PiuError('RANK_ID', '每次请指定 1 至 100 个完整 GAME ID。');
  return combined.map(parseFullPlayer);
}

export function resolveFollowBatch(entries, selectors) {
  const resolved = [];
  for (const selector of selectors) {
    const canonical = canonicalPlayer(selector);
    const matches = entries.filter(row => canonicalPlayer(row) === canonical);
    if (matches.length > 1) throw new PiuError('RANK_ID', '同一完整档案在列表中重复出现，不能通过大小写区分，请先更新排行榜数据。');
    if (!matches.length) {
      const suggestions = entries.filter(row => row.tag === selector.tag).slice(0, 8).map(canonicalPlayer);
      throw new PiuError('RANK_NOT_FOUND', `未找到 ${canonicalPlayer(selector)}。${suggestions.length ? `同标签候选：${suggestions.join('、')}。` : '该档案可能不在当前保存的全球前 1000 名中。'}`);
    }
    if (!resolved.some(row => canonicalPlayer(row) === canonical)) resolved.push(matches[0]);
  }
  return resolved;
}

function followedRanks(snapshot, follows) {
  const keys = new Set(follows.map(row => row.playerKey));
  const rows = snapshot.entries.filter(row => keys.has(row.playerKey)).sort((a, b) => a.worldRank - b.worldRank);
  const map = new Map();
  let rank = 0, previousWorld = null;
  rows.forEach((row, index) => {
    if (row.worldRank !== previousWorld) rank = index + 1;
    previousWorld = row.worldRank;
    map.set(row.playerKey, {...row, countryRank: rank, followRank: rank});
  });
  return map;
}

/** The extra rank column is within the user's followed players, never inferred nationality. */
export function buildRankComparison(current, previous, follows) {
  const currentRows = followedRanks(current, follows);
  const previousRows = previous ? followedRanks(previous, follows) : new Map();
  return {current, previous, rankBasis: 'followed', scopeLabel: '关注用户 · 全球前 1000',
    rows: follows.map(follow => ({...follow, current: currentRows.get(follow.playerKey) ?? null,
      previous: previousRows.get(follow.playerKey) ?? null,
      status: currentRows.has(follow.playerKey) && !previousRows.has(follow.playerKey) ? 'NEW' : 'IN'}))};
}
