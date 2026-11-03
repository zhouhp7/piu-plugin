import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {normalizeGameIdSelector} from './parser.js';

/** Read only the latest complete capture; a previous appearance is not a current rank. */
export function lookupWorldRank(filename, playerName, {onError} = {}) {
  let identity;
  try { identity = normalizeGameIdSelector(playerName); }
  catch { return null; }
  if (!identity || typeof filename !== 'string' || !filename) return null;
  let db;
  try {
    // A short read-only connection never creates a missing database or owns the
    // ranking scheduler's writer. SQLite can read its committed WAL snapshots.
    db = new DatabaseSync(filename, {readOnly: true});
    const snapshot = db.prepare(`SELECT id,captured_at FROM ranking_snapshots
      WHERE entry_count = 1000 ORDER BY captured_at DESC,id DESC LIMIT 1`).get();
    if (!snapshot) return null;
    const row = db.prepare(`SELECT world_rank FROM ranking_entries
      WHERE snapshot_id = ? AND player_key = ?`).get(snapshot.id, `game:${identity}`);
    if (!Number.isInteger(row?.world_rank) || row.world_rank < 1 || row.world_rank > 1000) return null;
    return {worldRank: row.world_rank, capturedAt: snapshot.captured_at};
  } catch (error) {
    // Ranking is optional for B50; an absent/unreadable cache must not prevent
    // the authenticated score image from being generated.
    if (typeof onError === 'function') onError(error);
    return null;
  } finally { db?.close(); }
}

export function enrichProfileRanking(profile, {dataDir, filename, onError} = {}) {
  if (!filename && !dataDir) return profile;
  const rank = lookupWorldRank(filename ?? path.join(dataDir, 'rankings.sqlite'), profile?.playerName, {onError});
  return rank ? {...profile, ranking: String(rank.worldRank)} : profile;
}
