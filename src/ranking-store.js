import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {PiuError} from './errors.js';
import {parseDate, shanghaiDate, zoned01} from './ranking-time.js';
import {normalizeGameIdName, normalizeGameIdSelector} from './parser.js';

function invalid(message) { return new PiuError('RANK_SNAPSHOT', message); }

function text(value, name, {nullable = false, max = 1024} = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`排行榜数据中的 ${name} 无效。`);
  }
  return value.trim();
}

function timestamp(value, name, {nullable = false} = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalid(`${name} 必须包含时区。`);
  try { parseDate(value.slice(0, 10).replaceAll('-', '')); } catch { throw invalid(`${name} 无效。`); }
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw invalid(`${name} 无效。`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw invalid(`${name} 无效。`);
  return parsed.toISOString();
}

function json(value, name) {
  try {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error('undefined');
    return result;
  } catch { throw invalid(`${name} 不能保存为 JSON。`); }
}

function identity(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('排行榜档案无效。');
  text(entry.playerKey, 'playerKey', {max: 1024});
  let gameId;
  try { gameId = normalizeGameIdName(entry.gameId); }
  catch { throw invalid('排行榜 GAME ID 名称必须为 1 至 12 位英文字母或数字。'); }
  const tag = text(entry.tag, 'tag', {max: 5});
  if (!/^#\d{4}$/.test(tag)) throw invalid('排行榜 GAME ID 标签必须为 # 加四位数字。');
  const playerKey = `game:${gameId}${tag}`;
  const sourceId = entry.sourceId == null ? null : text(String(entry.sourceId), 'sourceId', {max: 1024});
  return {...entry, playerKey, gameId, tag, ...(sourceId == null ? {} : {sourceId})};
}

function followKey(value) {
  const key = text(value, 'playerKey', {max: 1024});
  const named = /^(?:game|name):(.+)$/.exec(key);
  if (!named) return key; // Legacy source IDs are opaque, not GAME ID names.
  try {
    const full = normalizeGameIdSelector(named[1]);
    if (!full) throw new Error();
    return `game:${full}`;
  } catch { throw invalid('取消关注的完整档案标识无效。'); }
}

function normalizeSnapshot(input, minEntries) {
  if (!input || typeof input !== 'object') throw invalid('缺少排行榜快照。');
  const date = parseDate(input.date).date;
  const capturedAt = timestamp(input.capturedAt, 'capturedAt');
  const kind = input.kind;
  if (!['scheduled', 'manual', 'catchup'].includes(kind)) throw invalid('排行榜快照类型无效。');
  const scheduledAt = timestamp(input.scheduledAt, 'scheduledAt', {nullable: true});
  if (shanghaiDate(capturedAt) !== date) throw invalid('抓取时间与 GMT+8 快照日期不一致；不能补造过去日期的数据。');
  if (kind === 'manual') {
    if (scheduledAt !== null) throw invalid('手动快照不能冒充凌晨 1:00 的定时快照。');
  } else if (scheduledAt !== zoned01(date) || new Date(capturedAt) < new Date(scheduledAt)) {
    throw invalid('定时快照必须指向当日 GMT+8 的 1:00，且不能提前抓取。');
  }
  if (!Array.isArray(input.entries) || input.entries.length < minEntries || input.entries.length > 1000) {
    throw invalid(`排行榜必须包含 ${minEntries === 1000 ? '完整的 1000' : `${minEntries} 至 1000`} 条记录；不完整的抓取不会入库。`);
  }
  const keys = new Set();
  let previousRank = 0;
  const entries = input.entries.map(entry => {
    const result = identity(entry);
    if (keys.has(result.playerKey)) throw invalid('排行榜出现重复档案标识，未保存快照。');
    keys.add(result.playerKey);
    if (!Number.isInteger(entry.worldRank) || entry.worldRank < 1 || entry.worldRank < previousRank) {
      throw invalid('世界排名必须为按顺序排列的正整数，未保存快照。');
    }
    previousRank = entry.worldRank;
    if (typeof entry.score !== 'number' || !Number.isFinite(entry.score) || entry.score < 0) throw invalid('排行榜 PUMBILITY 分数无效。');
    const country = text(entry.country, 'country', {nullable: true, max: 128});
    const lastPlayedAt = text(entry.lastPlayedAt, 'lastPlayedAt', {nullable: true, max: 128});
    return {...result, worldRank: entry.worldRank, score: entry.score, country, lastPlayedAt};
  });
  return {
    date, scheduledAt, capturedAt, kind,
    sourceUpdatedAt: text(input.sourceUpdatedAt, 'sourceUpdatedAt', {nullable: true, max: 256}),
    audit: input.audit ?? null,
    entries,
  };
}

function metadata(row) {
  if (!row) return null;
  return {
    id: Number(row.id), date: row.date, scheduledAt: row.scheduled_at,
    capturedAt: row.captured_at, sourceUpdatedAt: row.source_updated_at,
    kind: row.kind, count: Number(row.entry_count), audit: JSON.parse(row.audit_json),
  };
}

/** Immutable complete leaderboard captures and per-bot-user follow lists. */
export class RankingStore {
  constructor({filename, minEntries = 1000} = {}) {
    if (typeof filename !== 'string' || !filename) throw new TypeError('RankingStore requires filename.');
    if (!Number.isInteger(minEntries) || minEntries < 1 || minEntries > 1000) throw new TypeError('minEntries must be between 1 and 1000.');
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), {recursive: true});
    this.minEntries = minEntries;
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new Error('Unsupported ranking database schema.'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ranking_snapshots (
        id INTEGER PRIMARY KEY,
        date TEXT NOT NULL,
        scheduled_at TEXT,
        captured_at TEXT NOT NULL,
        source_updated_at TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('scheduled','manual','catchup')),
        entry_count INTEGER NOT NULL CHECK (entry_count BETWEEN 1 AND 1000),
        audit_json TEXT NOT NULL,
        UNIQUE(date, kind, captured_at)
      );
      CREATE INDEX IF NOT EXISTS ranking_snapshots_date ON ranking_snapshots(date, captured_at);
      CREATE TABLE IF NOT EXISTS ranking_entries (
        snapshot_id INTEGER NOT NULL REFERENCES ranking_snapshots(id) ON DELETE CASCADE,
        player_key TEXT NOT NULL,
        row_ordinal INTEGER NOT NULL,
        world_rank INTEGER NOT NULL,
        entry_json TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, player_key),
        UNIQUE(snapshot_id, row_ordinal)
      );
      CREATE TABLE IF NOT EXISTS ranking_follows (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        player_key TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        UNIQUE(owner, player_key)
      );
      PRAGMA user_version = 1;
    `);
  }

  saveSnapshot(input) {
    return this.saveSnapshotWithRollback(input).metadata;
  }

  /** Commit before asynchronous session I/O; compensate only this call's new row on failure. */
  saveSnapshotWithRollback(input) {
    const value = normalizeSnapshot(input, this.minEntries);
    const audit = json(value.audit, 'audit');
    const rows = value.entries.map(entry => ({entry, serialized: json(entry, '排行榜记录')}));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM ranking_snapshots WHERE date = ? AND kind = ? AND captured_at = ?')
        .get(value.date, value.kind, value.capturedAt);
      if (existing) {
        const previous = this.#snapshot(existing);
        if (previous.scheduledAt !== value.scheduledAt || previous.sourceUpdatedAt !== value.sourceUpdatedAt || !isDeepStrictEqual(previous.audit, JSON.parse(audit)) || !isDeepStrictEqual(previous.entries, rows.map(row => JSON.parse(row.serialized)))) {
          throw invalid('同一抓取时间已有不同内容，不能覆盖历史快照。');
        }
        this.db.exec('COMMIT');
        return {metadata: metadata(existing), rollback() {}};
      }
      const result = this.db.prepare(`INSERT INTO ranking_snapshots
        (date,scheduled_at,captured_at,source_updated_at,kind,entry_count,audit_json)
        VALUES (?,?,?,?,?,?,?)`).run(value.date, value.scheduledAt, value.capturedAt, value.sourceUpdatedAt, value.kind, rows.length, audit);
      const id = Number(result.lastInsertRowid);
      const insert = this.db.prepare('INSERT INTO ranking_entries (snapshot_id,player_key,row_ordinal,world_rank,entry_json) VALUES (?,?,?,?,?)');
      for (const [index, {entry, serialized}] of rows.entries()) insert.run(id, entry.playerKey, index + 1, entry.worldRank, serialized);
      const saved = metadata(this.db.prepare('SELECT * FROM ranking_snapshots WHERE id = ?').get(id));
      this.db.exec('COMMIT');
      let rolledBack = false;
      return {metadata: saved, rollback: () => {
        if (rolledBack) return;
        this.db.prepare('DELETE FROM ranking_snapshots WHERE id = ?').run(id);
        rolledBack = true;
      }};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  #snapshot(row) {
    if (!row) return null;
    return {...metadata(row), entries: this.db.prepare('SELECT entry_json FROM ranking_entries WHERE snapshot_id = ? ORDER BY row_ordinal')
      .all(row.id).map(entry => identity(JSON.parse(entry.entry_json)))};
  }

  getSnapshot(date) {
    parseDate(date);
    // Select the earliest real capture of the 01:00 slot. Manual captures are
    // explicit fallbacks only for that same date, and retain their actual time.
    const scheduled = this.db.prepare(`SELECT * FROM ranking_snapshots WHERE date = ? AND kind IN ('scheduled','catchup')
      ORDER BY captured_at ASC, CASE kind WHEN 'scheduled' THEN 0 ELSE 1 END ASC, id ASC LIMIT 1`).get(date);
    const row = scheduled ?? this.db.prepare(`SELECT * FROM ranking_snapshots WHERE date = ? AND kind = 'manual'
      ORDER BY captured_at DESC,id DESC LIMIT 1`).get(date);
    return this.#snapshot(row);
  }

  latestSnapshot() {
    const row = this.db.prepare('SELECT date FROM ranking_snapshots ORDER BY date DESC,captured_at DESC,id DESC LIMIT 1').get();
    return row ? this.getSnapshot(row.date) : null;
  }

  listSnapshots() {
    return this.db.prepare('SELECT * FROM ranking_snapshots ORDER BY date DESC,captured_at DESC,id DESC').all().map(metadata);
  }

  follow(owner, entries) {
    owner = text(owner, 'owner', {max: 256});
    if (!Array.isArray(entries)) throw invalid('关注档案必须为数组。');
    const rows = entries.map(entry => {
      const canonical = identity(entry);
      return {playerKey: canonical.playerKey, payload: json(canonical, '关注档案')};
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT INTO ranking_follows (owner,player_key,entry_json) VALUES (?,?,?)');
      const update = this.db.prepare('UPDATE ranking_follows SET player_key = ?, entry_json = ? WHERE seq = ?');
      const remove = this.db.prepare('DELETE FROM ranking_follows WHERE seq = ?');
      for (const row of rows) {
        const existing = this.db.prepare('SELECT seq,entry_json FROM ranking_follows WHERE owner = ? ORDER BY seq').all(owner)
          .filter(saved => identity(JSON.parse(saved.entry_json)).playerKey === row.playerKey);
        if (!existing.length) insert.run(owner, row.playerKey, row.payload);
        else {
          // Normalize old name/source keys without losing follow insertion order.
          for (const duplicate of existing.slice(1)) remove.run(duplicate.seq);
          update.run(row.playerKey, row.payload, existing[0].seq);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getFollows(owner);
  }

  unfollow(owner, playerKeys) {
    owner = text(owner, 'owner', {max: 256});
    if (!Array.isArray(playerKeys)) throw invalid('取消关注档案必须为数组。');
    const keys = new Set(playerKeys.map(followKey));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.db.prepare('DELETE FROM ranking_follows WHERE seq = ?');
      const existing = this.db.prepare('SELECT seq,player_key,entry_json FROM ranking_follows WHERE owner = ?').all(owner);
      for (const row of existing) {
        if (keys.has(row.player_key) || keys.has(identity(JSON.parse(row.entry_json)).playerKey)) remove.run(row.seq);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getFollows(owner);
  }

  getFollows(owner) {
    owner = text(owner, 'owner', {max: 256});
    const canonical = new Map();
    for (const row of this.db.prepare('SELECT entry_json FROM ranking_follows WHERE owner = ? ORDER BY seq').all(owner)) {
      const entry = identity(JSON.parse(row.entry_json));
      if (!canonical.has(entry.playerKey)) canonical.set(entry.playerKey, entry);
    }
    return [...canonical.values()];
  }

  close() { this.db.close(); }
}
