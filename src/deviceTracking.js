import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SOURCES } from './config.js';
import { canonicalCodexKey } from './codexKeys.js';
import { DEVICE_IDS, sourceDevice } from './devices.js';

const TABLES = ['events', 'tool_calls', 'credit_usage', 'files'];
const MIGRATION = 'migration:devices:v2';
function only(set) { return set?.size === 1 ? [...set][0] : 'unknown'; }
function add(map, key, device) {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(device);
}
function identity(tool, id) { return typeof id === 'string' && id ? `${tool}\0${id}` : null; }

/** Add attribution metadata without reparsing usage or changing accounting/dedup keys. */
export function migrateDevices(db) {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION)) {
      db.exec('COMMIT'); return;
    }
    for (const table of TABLES) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'device')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN device TEXT NOT NULL DEFAULT 'unknown'`);
      }
      if (table !== 'files') db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_device_ts ON ${table}(device, ts)`);
    }
    const sessions = new Map(), stems = new Map(), origins = new Map();
    const fileTag = db.prepare('UPDATE files SET device = ? WHERE path = ?');
    for (const file of db.prepare('SELECT tool, path, session_id FROM files').all()) {
      const device = sourceDevice(file.path);
      add(origins, file.tool, device);
      fileTag.run(device, file.path);
      add(sessions, identity(file.tool, file.session_id), device);
      const stem = basename(file.path).replace(/\.jsonl(?:\.(?:zst|zstd))?$/i, '');
      add(stems, identity(file.tool, stem), device);
      const uuid = stem.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i)?.[0];
      add(sessions, identity(file.tool, uuid), device);
      // The approved Windows projection hashes file and message session identities differently.
      // Read only its sanitized exports, never the original Windows sessions.
      if (device === 'windows' && file.path.endsWith('.jsonl')) {
        try {
          for (const line of readFileSync(file.path, 'utf8').split('\n')) {
            if (!line) continue;
            let r; try { r = JSON.parse(line); } catch { continue; }
            const sid = r.sessionId || r.session_id || r.payload?.session_id;
            if (typeof sid === 'string') add(sessions, identity(file.tool, sid), device);
          }
        } catch { /* Unavailable source stays unknown; usage history remains intact. */ }
      }
    }
    const toolDefaults = new Map(SOURCES.map(s => [s.tool,
      s.kind === 'poller' ? 'local' : only(new Set([
        ...s.roots.map(root => sourceDevice(root)), ...(origins.get(s.tool) || []),
      ]))]));
    for (const table of ['events', 'tool_calls', 'credit_usage']) {
      const tag = db.prepare(`UPDATE ${table} SET device = ? WHERE rowid = ?`);
      const hasSession = table !== 'credit_usage';
      for (const row of db.prepare(`SELECT rowid rid, tool, dedup_key, device${hasSession ? ', session_id' : ''} FROM ${table}`).all()) {
        // Preserve known provenance when an accounting upgrade recreates only some rows.
        if (DEVICE_IDS.includes(row.device) && row.device !== 'unknown') continue;
        const sid = hasSession ? sessions.get(identity(row.tool, row.session_id)) : null;
        const key = row.tool === 'codex' ? canonicalCodexKey(row.dedup_key) : row.dedup_key;
        const stem = key.match(/^codex:(?:tc:)?file:(.+):[^:]+$/)?.[1];
        const file = stem ? stems.get(identity(row.tool, stem)) : null;
        const candidates = new Set([...(sid || []), ...(file || [])]);
        const device = candidates.size ? only(candidates) : toolDefaults.get(row.tool) || 'unknown';
        tag.run(device, row.rid);
      }
    }
    db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run(MIGRATION, '1');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Compatible with the existing Store. Context applies only during synchronous staged replay. */
export function installDeviceTracking(store) {
  if (store._deviceTracking) return;
  migrateDevices(store.db);
  store._deviceTracking = true;
  store._deviceContext = 'local';
  for (const [table, methods] of [['events', ['insertEvent', 'insertDshEvent', 'upsertClaudeEvent', 'upsertAntigravityEvent']],
    ['tool_calls', ['insertToolCall']], ['credit_usage', ['insertCredit']]]) {
    const tag = store.db.prepare(`UPDATE ${table} SET device = ? WHERE dedup_key = ? AND device = 'unknown'`);
    for (const name of methods) {
      if (typeof store[name] !== 'function') continue;
      const original = store[name];
      store[name] = function(record, ...args) {
        const result = original.call(this, record, ...args);
        const key = record.tool === 'codex' ? canonicalCodexKey(record.dedup_key) : record.dedup_key;
        tag.run(this._deviceContext, key);
        return result;
      };
    }
  }
  const stage = store.stageWrites;
  store.stageWrites = function({ device = 'local' } = {}) {
    if (!DEVICE_IDS.includes(device)) throw new Error('Invalid source device');
    const result = stage.call(this), replay = result.replay;
    result.replay = () => {
      const before = this._deviceContext;
      this._deviceContext = device;
      try { return replay(); } finally { this._deviceContext = before; }
    };
    return result;
  };
  const save = store.saveFile, tagFile = store.db.prepare('UPDATE files SET device = ? WHERE path = ?');
  store.saveFile = function(record) {
    const result = save.call(this, record);
    tagFile.run(sourceDevice(record.path), record.path);
    return result;
  };
}
