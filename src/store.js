import { DatabaseSync } from 'node:sqlite';
import { normalizeModel } from './models.js';
import { canonicalCodexKey, migrateCodexKeys, offloadCodexKeyArchive } from './codexKeys.js';
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
-- Codex 首扫按会话茎名找同名副本（dropStaleCodexRows）：无索引时每个文件全表扫一遍，首扫 O(n²)
CREATE INDEX IF NOT EXISTS idx_files_tool_session ON files(tool, session_id);

CREATE TABLE IF NOT EXISTS quota (
  tool TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL                      -- 最新配额快照 JSON（含 balance:* 余额）
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                      -- JSON 编码；榜单开关/昵称/匿名 ID 等
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
CREATE TABLE IF NOT EXISTS credit_usage (
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,                     -- qoder 等以积分为计费单位的源
  amount REAL NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_credit_ts ON credit_usage(ts);
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
function migrate(db, dbPath) {
  migrateCodexKeys(db);
  // 归档搬家纯属腾空间：失败不该拦住启动，原表留在库里下次再试。
  try { offloadCodexKeyArchive(db, dbPath); } catch { /* 并发占锁或磁盘满：下次启动重试 */ }
  const cols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
  if (!cols.includes('trace_id')) db.exec('ALTER TABLE events ADD COLUMN trace_id TEXT');
  // Antigravity: 0=历史未知，1=字符估算，2=真实上下文+估算输出，3=逐轮真实 usage。
  // claude-code: 1=audit 回退，2=标准 transcript；旧 0 行来自原标准解析器。
  if (!cols.includes('usage_quality')) db.exec('ALTER TABLE events ADD COLUMN usage_quality INTEGER NOT NULL DEFAULT 0');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_session'").get();
  if (!idx) db.exec('CREATE INDEX idx_events_session ON events(session_id)'); // 会话钻取/模型回填高频查询
  // v2 模型归一：大小写变体合并（GLM-5.3-Flash → glm-5.3-flash）
  const upd = db.prepare('UPDATE events SET model = ? WHERE model = ?');
  for (const r of db.prepare('SELECT DISTINCT model FROM events WHERE model IS NOT NULL').all()) {
    const n = normalizeModel(r.model);
    if (n && n !== r.model) upd.run(n, r.model);
  }
  const updRates = db.prepare('UPDATE rates SET model = ? WHERE model = ?');
  for (const r of db.prepare('SELECT DISTINCT model FROM rates').all()) {
    const n = normalizeModel(r.model);
    if (n && n !== r.model) {
      try { updRates.run(n, r.model); } catch { /* 归一后与既有键冲突：保留旧行，下次学习覆盖 */ }
    }
  }
}

/** 采集器可能调用的全部写方法：stageWrites() 代理这些，其余（读）直通 */
const STAGED_WRITES = ['insertEvent', 'insertDshEvent', 'insertToolCall', 'insertCredit',
  'saveQuota', 'dropStaleCodexRows', 'correctEventInput', 'upsertAntigravityEvent', 'upsertClaudeEvent'];

export class Store {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // 常驻 serve 与一次性 CLI（today/scan）会并发访问同一库：不设超时则立刻 SQLITE_BUSY
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    try { migrate(this.db, dbPath); }
    catch (err) { this.db.close(); throw err; }
    this._insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (ts, tool, model, session_id, project,
         input_tokens, cached_input, cache_write, output_tokens, reasoning_tokens, total_tokens, dedup_key, trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // 去重命中时的补登：同一次 API 响应可能被拆成多行写入（Claude Code transcript 按
    // content block 分行），input/cached 每行重复，只有终结块带真实 output_tokens，
    // 先到的行是 0。ccmr 网关还不写 requestId，四个 block 会塌成同一个 dedup_key，
    // 纯"先到者胜"会把输出永久钉死在 0（实测丢掉 94.5% 的输出量）。
    // 用量更大的后来者补齐该行；无冲突时行为与从前完全一致。
    this._supersedeEvent = this.db.prepare(`
      UPDATE events SET
        input_tokens = ?, cached_input = ?, cache_write = ?,
        output_tokens = ?, reasoning_tokens = ?, total_tokens = ?
      WHERE dedup_key = ? AND output_tokens < ?`);
    this._deleteLegacyDshEvent = this.db.prepare("DELETE FROM events WHERE tool = 'dsh' AND dedup_key = ?");
    this._getClaudeEvent = this.db.prepare("SELECT * FROM events WHERE tool = 'claude-code' AND dedup_key = ?");
    this._getClaudeAliases = this.db.prepare(`SELECT * FROM events
      WHERE dedup_key >= ? AND dedup_key < ?`);
    this._deleteClaudeAlias = this.db.prepare("DELETE FROM events WHERE id = ? AND tool = 'claude-code'");
    this._updateClaudeEvent = this.db.prepare(`UPDATE events SET
      ts = ?, model = ?, session_id = ?, project = ?, input_tokens = ?, cached_input = ?,
      cache_write = ?, output_tokens = ?, reasoning_tokens = ?, total_tokens = ?, usage_quality = ?
      WHERE dedup_key = ? AND tool = 'claude-code'`);
    this._insertToolCall = this.db.prepare(`
      INSERT OR IGNORE INTO tool_calls (ts, tool, name, session_id, dedup_key)
      VALUES (?, ?, ?, ?, ?)`);
    this._insertCredit = this.db.prepare(
      'INSERT OR IGNORE INTO credit_usage (ts, tool, amount, dedup_key) VALUES (?, ?, ?, ?)');
    this._correctEventInput = this.db.prepare(
      'UPDATE events SET input_tokens = ?, total_tokens = ? + output_tokens + reasoning_tokens WHERE dedup_key = ?');
    this._updateAntigravity = this.db.prepare(`
      UPDATE events SET
        model = COALESCE(?, model), input_tokens = ?, cached_input = ?, cache_write = 0,
        output_tokens = ?, reasoning_tokens = ?, total_tokens = ?, usage_quality = ?
      WHERE dedup_key = ? AND tool = 'antigravity'
        AND (usage_quality < ? OR (usage_quality = ?
          AND (? = 3 OR (? = 2 AND output_tokens <= ?) OR (? = 1 AND total_tokens <= ?))))`);
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
    const dedupKey = e.tool === 'codex' ? canonicalCodexKey(e.dedup_key) : e.dedup_key;
    const r = this._insertEvent.run(
      e.ts, e.tool, e.model ?? null, e.session_id ?? null, e.project ?? null,
      e.input_tokens || 0, e.cached_input || 0, e.cache_write || 0,
      e.output_tokens || 0, e.reasoning_tokens || 0, e.total_tokens || 0, dedupKey,
      e.trace_id ?? null
    );
    if (r.changes) return 1;
    // 已存在同 key 的行：若这条携带更多输出，说明先到的是同一次响应的前置分片，补齐它
    this._supersedeEvent.run(
      e.input_tokens || 0, e.cached_input || 0, e.cache_write || 0,
      e.output_tokens || 0, e.reasoning_tokens || 0, e.total_tokens || 0,
      dedupKey, e.output_tokens || 0
    );
    return 0; // 事件数不变，只是把已有行补全
  }

  /**
   * DSH 从日志行键迁移到请求键。只删除这次原始快照中实际找到的旧键；不能清空整
   * 个会话，新旧文件各自可能有独有请求，源文件消失的历史也不能凭猜测删除。
   * Scanner 的文件事务保证新行、旧键删除与游标一起提交或一起回滚。
   */
  insertDshEvent(e, legacyKeys) {
    const inserted = this.insertEvent(e);
    for (const key of legacyKeys) {
      if (key !== e.dedup_key) this._deleteLegacyDshEvent.run(key);
    }
    return inserted;
  }

  /**
   * One official message can occur in CLI, Cowork transcript, audit and mirrors.
   * Only migrate old keys for the message actually observed in this scan. Keep
   * missing-source history; the Scanner commits migration and cursor atomically.
   */
  upsertClaudeEvent(e, messageId) {
    if (e.tool !== 'claude-code' || ![1, 2].includes(e.usage_quality) ||
        !messageId || e.dedup_key !== `claude-code:message:${messageId}`) throw new Error('invalid Claude event');
    const current = this._getClaudeEvent.get(e.dedup_key);
    const prefix = `claude-code:${messageId}:`;
    const aliases = this._getClaudeAliases.all(prefix, `claude-code:${messageId};`)
      .filter(row => row.tool === 'claude-code' && !row.dedup_key.startsWith('claude-code:message:'));
    let best = e;
    for (const old of [current, ...aliases].filter(Boolean)) {
      const candidate = { ...old, usage_quality: old.usage_quality || 2 };
      if (candidate.usage_quality > best.usage_quality ||
          (candidate.usage_quality === best.usage_quality &&
            (candidate.output_tokens > best.output_tokens ||
              (candidate.output_tokens === best.output_tokens && candidate.total_tokens >= best.total_tokens)))) best = candidate;
    }
    // Enrich missing metadata without changing the chosen usage or source priority.
    const fields = ['ts', 'model', 'session_id', 'project', 'input_tokens', 'cached_input',
      'cache_write', 'output_tokens', 'reasoning_tokens', 'total_tokens', 'usage_quality'];
    const chosen = { ...best, model: best.model ?? e.model ?? null,
      project: best.project ?? e.project ?? null, session_id: best.session_id ?? e.session_id ?? null };
    if (!current) this._insertEvent.run(
      chosen.ts, e.tool, chosen.model, chosen.session_id, chosen.project,
      chosen.input_tokens || 0, chosen.cached_input || 0, chosen.cache_write || 0,
      chosen.output_tokens || 0, chosen.reasoning_tokens || 0, chosen.total_tokens || 0,
      e.dedup_key, best.trace_id ?? null);
    if (!current || fields.some(k => (current[k] ?? null) !== (chosen[k] ?? null))) {
      this._updateClaudeEvent.run(...fields.map(k => chosen[k] ?? null), e.dedup_key);
    }
    for (const row of aliases) this._deleteClaudeAlias.run(row.id);
    return current || aliases.length ? 0 : 1;
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

  /** 权威值到位后补正按估算入账的事件（antigravity）：total 用库里的 output/reasoning 重算 */
  correctEventInput(dedupKey, input) {
    this._correctEventInput.run(input, input, dedupKey);
  }

  /** 真 usage 即使小于旧估算也须覆盖；旧日志/晚到 metadata 永远不能覆盖实数。 */
  upsertAntigravityEvent(e) {
    if (e.tool !== 'antigravity' || ![1, 2, 3].includes(e.usage_quality)) throw new Error('invalid Antigravity event');
    const n = this._insertEvent.run(
      e.ts, e.tool, e.model ?? null, e.session_id ?? null, e.project ?? null,
      e.input_tokens, e.cached_input, 0, e.output_tokens, e.reasoning_tokens,
      e.total_tokens, e.dedup_key, null,
    ).changes;
    this._updateAntigravity.run(
      e.model ?? null, e.input_tokens, e.cached_input, e.output_tokens, e.reasoning_tokens,
      e.total_tokens, e.usage_quality, e.dedup_key,
      e.usage_quality, e.usage_quality, e.usage_quality,
      e.usage_quality, e.output_tokens, e.usage_quality, e.total_tokens,
    );
    return n;
  }

  /**
   * 采集器专用的写入代理：写操作先按顺序记下，解析（含异步读文件、解压）结束后由扫描器
   * 在一个同步事务里 replay()。事务因此从不跨 await——同一连接上的轮询器 / 设置写入
   * 不会被卷进采集事务、被它的回滚一起撤销；写锁也只在回放那一刻持有，不挡并发的 CLI。
   * 读操作照常直通。回放严格按记录顺序，同一文件内"先插后补"的语义不变。
   * 代理上的写方法恒返回 0；真实新增数由 replay() 返回。采集器不得绕过代理直接写 store.db。
   */
  stageWrites() {
    const ops = [];
    let changed = false;
    const staged = Object.create(this);
    for (const name of STAGED_WRITES) {
      staged[name] = (...args) => { ops.push([name, args]); return 0; };
    }
    const replay = () => {
      let inserted = 0;
      const before = this.db.prepare('SELECT total_changes() n').get().n;
      for (const [name, args] of ops) {
        const r = this[name](...args);
        if (['insertEvent', 'insertDshEvent', 'upsertAntigravityEvent', 'upsertClaudeEvent'].includes(name)) inserted += r;
      }
      changed = this.db.prepare('SELECT total_changes() n').get().n > before;
      return inserted;
    };
    return { store: staged, replay, get changed() { return changed; } };
  }

  insertToolCall(e) {
    return this._insertToolCall.run(e.ts, e.tool, e.name, e.session_id ?? null, e.tool === 'codex' ? canonicalCodexKey(e.dedup_key) : e.dedup_key).changes;
  }

  /**
   * 整文件重扫前，清掉这个 Codex rollout 按旧规则入库的事件与工具调用。
   * 事件键是文件内序号，采集规则一变序号就错位：旧行既对不上也盖不掉，只能整文件重建。
   *
   * 同名文件可能同时躺在几个目录里（归档搬移、第三方工具复制）。只要其中一份已被
   * 当前版本采集过，库里就是当前规则的行：这时不清，让后来的副本靠去重键并进去，
   * 否则一份只抄了前半截的旧副本会冲掉原文件的后半截。
   * 只按键的区间删（':' 的下一个字符是 ';'），文件名只是前缀相同的不会被波及。
   */
  dropStaleCodexRows(stem, path, version) {
    const siblings = this.db.prepare(
      "SELECT state_json FROM files WHERE tool = 'codex' AND session_id = ? AND path <> ?").all(stem, path);
    const current = siblings.some((f) => {
      try { return JSON.parse(f.state_json)?._v === version; } catch { return false; }
    });
    if (current) return false;
    // `+tool` 让 SQLite 走 dedup_key 唯一索引做区间删：写成 tool = 'codex' 时它会选
    // idx_events_tool_ts，每个新文件都把全部 Codex 事件扫一遍（5000 文件首扫 114s → 10s）。
    for (const [table, prefix] of [['events', 'codex:file:'], ['tool_calls', 'codex:tc:file:']]) {
      this.db.prepare(`DELETE FROM ${table} WHERE +tool = 'codex' AND dedup_key >= ? AND dedup_key < ?`)
        .run(`${prefix}${stem}:`, `${prefix}${stem};`);
    }
    return true;
  }

  /** 积分账本（Qoder 等源）：幂等入账，返回是否为新行 */
  insertCredit(e) {
    return this._insertCredit.run(e.ts, e.tool, e.amount, e.dedup_key).changes === 1;
  }

  /** 各积分源的今日/累计消耗 */
  creditSummary() {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const out = {};
    for (const r of this.db.prepare(
      'SELECT tool, SUM(amount) total FROM credit_usage GROUP BY tool').all()) {
      out[r.tool] = { total: r.total || 0, today: 0 };
    }
    for (const r of this.db.prepare(
      'SELECT tool, SUM(amount) t FROM credit_usage WHERE ts >= ? GROUP BY tool').all(dayStart.getTime())) {
      if (out[r.tool]) out[r.tool].today = r.t || 0;
    }
    return out;
  }

  countEvents() {
    return this.db.prepare('SELECT COUNT(*) AS n, SUM(total_tokens) AS total FROM events').get();
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, JSON.stringify(value));
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
