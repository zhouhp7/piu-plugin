import {readFile} from 'node:fs/promises';

export const GRADE_CODES = Object.freeze(['F', 'D', 'C', 'B', 'A', 'A+', 'AA', 'AA+', 'AAA', 'AAA+', 'S', 'S+', 'SS', 'SS+', 'SSS', 'SSS+']);
export const PLATE_CODES = Object.freeze(['RG', 'FG', 'TG', 'MG', 'SG', 'EG', 'UG', 'PG']);

/** Fixed bundled paths: account data never selects a file or an asset URL. */
export const BADGE_FILES = Object.freeze([
  ...GRADE_CODES.map(code => Object.freeze({kind: 'grades', code,
    file: `grades/${code.toLowerCase().replace('+', '_p')}.png`})),
  ...GRADE_CODES.map(code => Object.freeze({kind: 'grades', code: `X_${code}`,
    file: `grades/x_${code.toLowerCase().replace('+', '_p')}.png`})),
  ...PLATE_CODES.map(code => Object.freeze({kind: 'plates', code,
    file: `plates/s_${code.toLowerCase()}.png`})),
]);

let pending;
/** Original official PNG bytes; rendering can scale these without redrawing their artwork. */
export async function loadBadgeAssets() {
  if (!pending) {
    pending = Promise.all(BADGE_FILES.map(async item => ({...item,
      bytes: await readFile(new URL(`../assets/${item.file}`, import.meta.url))})))
      .then(entries => ({
        grades: new Map(entries.filter(item => item.kind === 'grades').map(item => [item.code, item.bytes])),
        plates: new Map(entries.filter(item => item.kind === 'plates').map(item => [item.code, item.bytes])),
      })).catch(error => { pending = undefined; throw error; });
  }
  return pending;
}
