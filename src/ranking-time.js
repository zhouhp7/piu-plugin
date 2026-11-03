import {PiuError} from './errors.js';

const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;

function dateError(message = '日期格式应为 YYYYMMDD，例如 20261103。') {
  return new PiuError('RANK_DATE', message);
}

/** Parse a real Gregorian calendar date without using the host time zone. */
export function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) throw dateError();
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1900 || year > 9999) throw dateError('日期年份应在 1900 至 9999 之间。');
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) {
    throw dateError('日期不存在，请检查年月日。');
  }
  return {year, month, day, date: value};
}

function instant(value) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw dateError('无效的时间。');
  return result;
}

function formatUtcDate(value) {
  return `${String(value.getUTCFullYear()).padStart(4, '0')}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`;
}

/** Calendar date in GMT+8, independent of the machine's configured time zone. */
export function shanghaiDate(value = new Date()) {
  return formatUtcDate(new Date(instant(value).getTime() + SHANGHAI_OFFSET));
}

/** The exact 01:00 GMT+8 target, represented as an absolute UTC ISO string. */
export function zoned01(value) {
  const {year, month, day} = parseDate(value);
  return new Date(Date.UTC(year, month - 1, day, 1) - SHANGHAI_OFFSET).toISOString();
}

/** Calendar this Monday versus last Monday, even before this Monday's 01:00. */
export function defaultComparison(now = new Date()) {
  const shifted = new Date(instant(now).getTime() + SHANGHAI_OFFSET);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const monday = new Date(midnight - ((shifted.getUTCDay() + 6) % 7) * DAY);
  const firstDate = formatUtcDate(monday);
  const secondDate = formatUtcDate(new Date(monday.getTime() - 7 * DAY));
  parseDate(firstDate);
  parseDate(secondDate);
  return {firstDate, secondDate};
}

/** Keep the user's requested comparison order; never substitute another date. */
export function comparisonDates(first, second, now = new Date()) {
  if (first == null && second == null) return defaultComparison(now);
  if (first == null || second == null) throw dateError('请同时提供两个日期，例如 #piu rank 20261103 20261003。');
  return {firstDate: parseDate(first).date, secondDate: parseDate(second).date};
}

/** The next daily 01:00 GMT+8 strictly after now. */
export function nextDaily01(now = new Date()) {
  const current = instant(now);
  let target = new Date(zoned01(shanghaiDate(current)));
  if (target.getTime() <= current.getTime()) target = new Date(target.getTime() + DAY);
  return target;
}
