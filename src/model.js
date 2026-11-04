/**
 * The renderer's public interchange format. Values missing from the source stay
 * missing: in particular, this module never calculates a chart rating.
 */

import {normalizeTitleProgress} from './title-progress.js';

const MODES = new Map([
  ['S', 'S'], ['SINGLE', 'S'],
  ['D', 'D'], ['DOUBLE', 'D'],
  ['SP', 'SP'], ['SINGLEPERFORMANCE', 'SP'],
  ['DP', 'DP'], ['DOUBLEPERFORMANCE', 'DP'],
  ['COOP', 'COOP'], ['COOPERATIVE', 'COOP'],
]);

function text(value, fallback = null, maxLength = 500) {
  if (value === null || value === undefined) return fallback;
  const result = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
  return result || fallback;
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const cleaned = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  if (cleaned === '') return null;
  const candidate = typeof cleaned === 'number' ? cleaned : Number(cleaned);
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
}

function mode(value) {
  const key = String(value ?? '').trim().toUpperCase().replace(/[\s_-]/g, '');
  return MODES.get(key) ?? 'UNKNOWN';
}

/**
 * Normalize a plain JSON profile without sorting the official records.
 * Records after the first 50 are omitted. Missing numeric values become null.
 * demo:true is an explicit, optional marker for fabricated example data.
 *
 * @param {object} input
 * @returns {{kind:string,playerName:string,pumbility:number|null,ranking:string|null,
 *   avatar:string|null,updatedAt:string|null,demo:boolean,records:Array}}
 */
export function normalizeProfile(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Profile must be a JSON object.');
  }
  const source = Array.isArray(input.records) ? input.records : [];
  return {
    kind: input.kind === 'recent' ? 'recent' : 'best50',
    playerName: text(input.playerName, 'PIU PLAYER', 120),
    pumbility: number(input.pumbility),
    ranking: text(input.ranking, null, 80),
    avatar: text(input.avatar, null, 2048),
    updatedAt: text(input.updatedAt, null, 120),
    demo: input.demo === true,
    titleProgress: normalizeTitleProgress(input.titleProgress),
    records: source.slice(0, 50).map((record, index) => {
      const item = record && typeof record === 'object' ? record : {};
      const rank = number(item.rank);
      return {
        rank: rank && Number.isInteger(rank) ? rank : index + 1,
        title: text(item.title, 'Unknown song', 240),
        mode: mode(item.mode),
        level: number(item.level),
        score: number(item.score),
        grade: text(item.grade, '—', 32),
        gradeCode: text(item.gradeCode, null, 32),
        failed: item.failed === true,
        stageBreak: item.stageBreak === true,
        plate: text(item.plate, null, 24),
        rating: number(item.rating),
        jacket: text(item.jacket, null, 2048),
        playedAt: text(item.playedAt, null, 120),
      };
    }),
  };
}

export default normalizeProfile;
