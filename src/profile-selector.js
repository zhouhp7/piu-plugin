import {PiuError} from './errors.js';
import {normalizeGameIdName,normalizeGameIdSelector} from './parser.js';

const formatError = () => new PiuError('GAME_ID_FORMAT', '档案选择格式无效。请用 #piu list 查看档案，使用正整数序号、名称、#四位标签或完整的 名称#四位标签。');
const notFound = () => new PiuError('GAME_ID_NOT_FOUND', '未找到该档案。请用 #piu list 查看当前列表；档案有变动时可先用 #piu refresh 刷新。');
const ambiguous = () => new PiuError('GAME_ID_AMBIGUOUS', '多个档案符合该名称或标签，无法唯一选择。请用 #piu list 查看序号，并使用序号或完整的 名称#四位标签。');

/** Normalize human input without converting arbitrary objects or credentials to text. */
export function normalizeProfileInput(input) {
  if (input === undefined) return '';
  if (typeof input !== 'string') throw formatError();
  const value = input.replace(/\s+/gu, ' ').normalize('NFC').trim();
  if (value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw formatError();
  return value;
}

function describe(row) {
  if (!row || typeof row !== 'object') return null;
  const source = typeof row.playerName === 'string' && row.playerName.trim()
    ? row.playerName
    : typeof row.gameId === 'string' && typeof row.tag === 'string' ? `${row.gameId}${row.tag}` : '';
  let normalized;
  try { normalized = normalizeGameIdSelector(source); }
  catch { return null; }
  const match = /^([A-Z0-9]{1,12})(#\d{4})$/.exec(normalized);
  if (!match) return null;
  return {row, name:match[1], tag:match[2], fullName:normalized};
}

function unique(matches) {
  if (!matches.length) throw notFound();
  if (matches.length !== 1) throw ambiguous();
  return matches[0].row;
}

/** Resolve against this user's flattened, displayed list and return its original row. */
export function resolveProfileSelector(rows, input) {
  const value = normalizeProfileInput(input);
  if (!value) throw formatError();
  if (!Array.isArray(rows)) throw new TypeError('Profile rows must be an array');

  if (/^[1-9]\d*$/.test(value)) {
    // Compare before converting so arbitrarily large integers cannot lose precision.
    const ordinal = BigInt(value);
    if (ordinal > BigInt(rows.length)) throw notFound();
    const row = rows[Number(ordinal) - 1];
    if (!row || typeof row !== 'object') throw notFound();
    return row;
  }
  if (/^\d+$/.test(value)) throw formatError();

  const profiles = rows.map(describe).filter(Boolean);
  const tag = /^#\s*(\d{4})$/.exec(value);
  if (tag) return unique(profiles.filter(profile => profile.tag === `#${tag[1]}`));
  if (value.includes('#')) {
    let canonical;
    try { canonical = normalizeGameIdSelector(value); }
    catch { throw formatError(); }
    return unique(profiles.filter(profile => profile.fullName === canonical));
  }

  let name;
  try { name = normalizeGameIdName(value); }
  catch { throw formatError(); }
  return unique(profiles.filter(profile => profile.name === name));
}
