import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 归一化事件模型：
 *   ts(ms) | tool | model | session_id | project
 *   input_tokens(不含缓存) | cached_input(缓存读) | cache_write | output_tokens | reasoning_tokens
 *   total_tokens(按各源语义计算的总口径)
 * dedup_key 全局唯一，重复解析同一文件区域时 INSERT OR IGNORE 幂等。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,
  model TEXT,
  session_id TEXT,
  project TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_tool_ts ON events(tool, ts);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  session_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,     -- 已解析到的字节偏移（仅推进到完整行尾）
  state_json TEXT,                        -- collector 跨次解析所需状态（codex 累计用量/当前模型等）
  last_scan_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quota (
  tool TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL                      -- 最新配额快照 JSON（含 balance:* 余额）
);

CREATE TABLE IF NOT EXISTS rates (
  model TEXT PRIMARY KEY,
  fresh_rate REAL NOT NULL,               -- 积分 / 百万新输入 token
  cache_rate REAL NOT NULL,               -- 积分 / 百万缓存读 token
  out_rate REAL NOT NULL,                 -- 积分 / 百万输出 token
  turns INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS balance_history (
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  balance REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,                     -- claude-code | ccmr | zcode
  name TEXT NOT NULL,
  session_id TEXT,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(ts);
`;

/** 增量迁移：旧库补列、模型名归一（幂等，每次启动跑一遍，DISTINCT 很小） */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
  if (!cols.includes('trace_id')) db.exec('ALTER TABLE events ADD COLUMN trace_id TEXT');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_session'").get();
  if (!idx) db.exec('CREATE INDEX idx_events_session ON events(session_id)'); // 会话钻取/模型回填高频查询
  // v2 模型归一：大小写变体合并（GLM-5.3-Flash → glm-5.3-flash）
  const upd = db.prepare('UPDATE events SET model = ? WHERE model = ?');
  for (const r of db.prepare('SELECT DISTINCT model FROM events WHERE model IS NOT NULL').all()) {
    const n = typeof r.model === 'string' ? r.model.trim().toLowerCase() : r.model;
    if (n && n !== r.model) upd.run(n, r.model);
  }
  const updRates = db.prepare('UPDATE rates SET model = ? WHERE model = ?');
  for (const r of db.prepare('SELECT DISTINCT model FROM rates').all()) {
    const n = typeof r.model === 'string' ? r.model.trim().toLowerCase() : r.model;
    if (n && n !== r.model) {
      try { updRates.run(n, r.model); } catch { /* 归一后与既有键冲突：保留旧行，下次学习覆盖 */ }
    }
  }
}

export class Store {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    migrate(this.db);
    this._insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (ts, tool, model, session_id, project,
         input_tokens, cached_input, cache_write, output_tokens, reasoning_tokens, total_tokens, dedup_key, trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this._insertToolCall = this.db.prepare(`
      INSERT OR IGNORE INTO tool_calls (ts, tool, name, session_id, dedup_key)
      VALUES (?, ?, ?, ?, ?)`);
    this._getFile = this.db.prepare('SELECT * FROM files WHERE path = ?');
    this._upsertFile = this.db.prepare(`
      INSERT INTO files (path, tool, session_id, size, mtime_ms, offset, state_json, last_scan_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        session_id = excluded.session_id, size = excluded.size, mtime_ms = excluded.mtime_ms,
        offset = excluded.offset, state_json = excluded.state_json, last_scan_ms = excluded.last_scan_ms`);
    this._upsertQuota = this.db.prepare(`
      INSERT INTO quota (tool, ts, data) VALUES (?, ?, ?)
      ON CONFLICT(tool) DO UPDATE SET ts = excluded.ts, data = excluded.data
      WHERE excluded.ts > quota.ts`); // 只接受更新的快照，扫描顺序无关
  }

  insertEvent(e) {
    const r = this._insertEvent.run(
      e.ts, e.tool, e.model ?? null, e.session_id ?? null, e.project ?? null,
      e.input_tokens || 0, e.cached_input || 0, e.cache_write || 0,
      e.output_tokens || 0, e.reasoning_tokens || 0, e.total_tokens || 0, e.dedup_key,
      e.trace_id ?? null
    );
    return r.changes; // 1=新插入 0=重复被忽略
  }

  saveRates(model, fresh, cache, out, turns) {
    this.db.prepare(`
      INSERT INTO rates (model, fresh_rate, cache_rate, out_rate, turns, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        fresh_rate = excluded.fresh_rate, cache_rate = excluded.cache_rate,
        out_rate = excluded.out_rate, turns = excluded.turns, updated_at = excluded.updated_at`)
      .run(model, fresh, cache, out, turns, Date.now());
  }

  getRates() {
    return this.db.prepare('SELECT * FROM rates ORDER BY model').all();
  }

  getBalances() {
    return this.db.prepare("SELECT tool, ts, data FROM quota WHERE tool LIKE 'balance:%' ORDER BY tool").all()
      .map(r => { const d = JSON.parse(r.data); return { ...d, ts: r.ts, id: r.tool.slice(8) }; });
  }

  getFile(path) { return this._getFile.get(path); }
  saveFile(rec) {
    this._upsertFile.run(
      rec.path, rec.tool, rec.session_id ?? null, rec.size, rec.mtime_ms,
      rec.offset, rec.state_json ?? null, Date.now());
  }
  saveQuota(tool, ts, data) {
    this._upsertQuota.run(tool, ts, JSON.stringify(data));
    if (tool.startsWith('balance:')) {
      this.db.prepare('INSERT INTO balance_history (ts, provider, balance) VALUES (?, ?, ?)')
        .run(ts, tool.slice(8), data.balance ?? 0);
    }
  }
  getQuota(tool) {
    const row = this.db.prepare('SELECT ts, data FROM quota WHERE tool = ?').get(tool);
    return row ? { ts: row.ts, data: JSON.parse(row.data) } : null;
  }

  insertToolCall(e) {
    return this._insertToolCall.run(e.ts, e.tool, e.name, e.session_id ?? null, e.dedup_key).changes;
  }

  countEvents() {
    return this.db.prepare('SELECT COUNT(*) AS n, SUM(total_tokens) AS total FROM events').get();
  }

  /** 供 CLI / 对账用 */
  byTool() {
    return this.db.prepare(`
      SELECT tool, COUNT(*) AS n, SUM(input_tokens) AS input, SUM(cached_input) AS cached,
             SUM(cache_write) AS cache_write, SUM(output_tokens) AS output, SUM(total_tokens) AS total
      FROM events GROUP BY tool ORDER BY total DESC`).all();
  }

  close() { this.db.close(); }
}
