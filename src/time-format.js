const SHANGHAI = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',
  month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

/** Display explicitly zoned timestamps in GMT+8, independent of the host zone. */
export function formatShanghaiTime(value, fallback = '—') {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value))) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  const p = Object.fromEntries(SHANGHAI.formatToParts(date).map(part => [part.type,part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} GMT+8`;
}
