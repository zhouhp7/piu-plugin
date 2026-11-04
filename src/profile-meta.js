import {load} from 'cheerio';

const EMPTY = {equippedTitle:null, lastAccessAt:null, lastArcade:null};
const SITE_OFFSET_MS = 9 * 60 * 60_000;

function text(value, limit) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/gu, ' ').trim();
  return cleaned ? [...cleaned].slice(0, limit).join('') : null;
}

/** Validate calendar parts before applying any timezone offset. */
function localEpoch(parts) {
  const [year,month,day,hour,minute,second,millisecond=0] = parts;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime();
}

function siteAccessTime(value) {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\s*\(GMT\+9\))?$/.exec(value);
  if (!match) return null;
  const epoch = localEpoch(match.slice(1).map(Number));
  return epoch === null ? null : new Date(epoch - SITE_OFFSET_MS).toISOString();
}

function zonedAccessTime(value) {
  if (value instanceof Date) value = Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string') return null;
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1, 7).map(Number);
  parts.push(Number((match[7] ?? '').padEnd(3, '0')));
  const epoch = localEpoch(parts);
  if (epoch === null) return null;
  let offset = 0;
  if (match[8] !== 'Z') {
    const hour = Number(match[8].slice(1, 3)), minute = Number(match[8].slice(4, 6));
    if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return null;
    offset = (hour * 60 + minute) * 60_000 * (match[8][0] === '+' ? 1 : -1);
  }
  return new Date(epoch - offset).toISOString();
}

/** Shared display metadata. Missing fields stay null; names are not inferred. */
export function normalizeProfileMeta(input) {
  return {equippedTitle:text(input?.equippedTitle, 120),
    lastAccessAt:zonedAccessTime(input?.lastAccessAt), lastArcade:text(input?.lastArcade, 200)};
}

/** The site's unzoned Last Access Date is GMT+9, regardless of host timezone. */
export function parseProfileMeta(htmlOrCheerio) {
  const $ = typeof htmlOrCheerio === 'string' ? load(htmlOrCheerio)
    : typeof htmlOrCheerio === 'function' && typeof htmlOrCheerio.root === 'function' ? htmlOrCheerio : null;
  if (!$) return {...EMPTY};
  const profile = $('.subProfile_wrap').first();
  let lastAccessAt = null, lastArcade = null, foundDate = false, foundArcade = false;
  profile.find('.time_w li').each((_, element) => {
    const value = text($(element).text(), 500) ?? '';
    const date = /^Last\s+Access\s+Date\s*[:：]\s*(.*)$/i.exec(value);
    const arcade = /^Recently\s+Access\s+Games\s*[:：]\s*(.*)$/i.exec(value);
    if (date && !foundDate) { lastAccessAt = siteAccessTime(date[1]); foundDate = true; }
    if (arcade && !foundArcade) { lastArcade = arcade[1]; foundArcade = true; }
  });
  return normalizeProfileMeta({equippedTitle:profile.find('.name_w .t1').first().text(), lastAccessAt, lastArcade});
}
