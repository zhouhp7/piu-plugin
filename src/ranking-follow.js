import {PiuError} from './errors.js';

export const canonicalPlayer = entry => `${entry.gameId}${entry.tag}`;

/** Explicit selectors always include both a name and the four-digit tag. */
export function parseFullPlayer(value) {
  const match = /^(.*?)\s*#(\d{4})$/.exec(String(value ?? '').trim());
  if (!match || !match[1].trim() || match[1].includes('#')) {
    throw new PiuError('RANK_ID', '请使用完整名称和四位标签，例如 SHAWN#1477；不接受纯名称或纯标签。');
  }
  return {gameId: match[1].normalize('NFC').trim(), tag: `#${match[2]}`};
}

/** Supports quoted names containing spaces, without treating input as shell code. */
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
  if (quote) throw new PiuError('RANK_ID', '名称引号未闭合。包含空格的名称请写成 "NAME WITH SPACE#1234"。');
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
    const exact = entries.filter(row => row.gameId === selector.gameId && row.tag === selector.tag);
    const matches = exact.length ? exact : entries.filter(row => row.gameId.toLocaleUpperCase('en-US') === selector.gameId.toLocaleUpperCase('en-US') && row.tag === selector.tag);
    if (matches.length > 1) throw new PiuError('RANK_ID', `完整名称仍有歧义，请使用官网显示的准确大小写：${matches.map(canonicalPlayer).join('、')}`);
    if (!matches.length) {
      const suggestions = entries.filter(row => row.tag === selector.tag).slice(0, 8).map(canonicalPlayer);
      throw new PiuError('RANK_NOT_FOUND', `未找到 ${canonicalPlayer(selector)}。${suggestions.length ? `同标签候选：${suggestions.join('、')}。` : '该档案可能不在当前保存的全球前 1000 名中。'}`);
    }
    if (!resolved.some(row => row.playerKey === matches[0].playerKey)) resolved.push(matches[0]);
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
