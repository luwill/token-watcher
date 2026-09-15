import { readdir, stat } from 'node:fs/promises';
import { watch as watchCb, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SOURCES } from './config.js';
import { collectClaudeFile } from './collectors/claude.js';
import { collectCodexFile } from './collectors/codex.js';
import { collectZcodeDb } from './collectors/zcode.js';
import { collectDshFile } from './collectors/dsh.js';
import { collectWorkbuddyFile } from './collectors/workbuddy.js';
import { collectGrokFile } from './collectors/grok.js';

const COLLECTORS = {
  claude: async (store, args) => ({ ...(await collectClaudeFile(store, args)), state: { _v: args.version } }),
  codex: collectCodexFile,
  zcode: collectZcodeDb,
  dsh: async (store, args) => ({ ...(await collectDshFile(store, args)), state: { _v: args.version } }), // 快照式，无跨次状态
  workbuddy: async (store, args) => ({ ...(await collectWorkbuddyFile(store, args)), state: { _v: args.version } }),
  grok: async (store, args) => ({ ...(await collectGrokFile(store, args)), state: { _v: args.version } }),
};

async function* walkByExt(root, match) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) yield* walkByExt(p, match);
    else if (e.isFile() && match(e.name)) yield p;
  }
}

/** 按源类型枚举待解析文件，返回 [path, sessionKey]；sqlite 直接判断文件存在 */
async function* enumerate(source) {
  if (source.kind === 'sqlite') {
    for (const root of source.roots) {
      const s = await stat(root).catch(() => null);
      if (s?.isFile()) yield [root, null];
    }
    return;
  }
  if (source.kind === 'zst') {
    for (const root of source.roots) {
      for await (const p of walkByExt(root, (n) => n.endsWith('.zst') || n.endsWith('.zstd'))) {
        yield [p, basename(dirname(p))]; // session.jsonl.zstd 全同名，以父目录为会话键
      }
    }
    return;
  }  for (const root of source.roots) {
    for await (const p of walkByExt(root, (n) => n.endsWith('.jsonl'))) yield [p, null];
  }
}

/** 当前确实存在的 roots；root 整体不可用（外置盘未挂载/目录重命名）时不清理其游标 */
async function liveRootsOf(source) {
  const out = [];
  for (const root of source.roots) {
    if (await stat(root).then(() => true).catch(() => false)) out.push(root);
  }
  return out;
}

export class Scanner extends EventEmitter {
  constructor(store, { log = () => {} } = {}) {
    super();
    this.store = store;
    this.log = log;
    this.scanning = false;
    this.stats = {}; // tool -> { files, parse_errors, last_error, last_scan_ms }
    this._watchers = [];
    this._debounceTimer = null;
    this._intervalTimer = null;
  }

  _stat(tool) {
    if (!this.stats[tool]) this.stats[tool] = { files: 0, parse_errors: 0, last_error: null, last_scan_ms: 0 };
    return this.stats[tool];
  }

  /** 全量增量扫描：游标未变的文件直接跳过。 */
  async scanAll({ quiet = false } = {}) {
    if (this.scanning) return { skippedConcurrent: true };
    this.scanning = true;
    const t0 = Date.now();
    let files = 0, inserted = 0;

    try {
    for (const src of SOURCES) {
      const st = this._stat(src.tool);
      st.parse_errors = 0; // 每轮重置为"本轮错误数"
      st.last_scan_ms = Date.now();
      const liveRoots = await liveRootsOf(src);
      const seen = new Set();
      for await (const [path, sessionKey] of enumerate(src)) {
        // 枚举与 stat 之间文件可能已被删除（Claude 会话清理 / Codex 归档搬移是常态）：
        // stat 抛 ENOENT 会让整轮扫描 reject，在防抖定时器里就是未处理 rejection → 进程退出
        const s = await stat(path).catch(() => null);
        if (!s) continue;
        files++;
        st.files++;
        seen.add(path);
        const fileId = sessionKey || basename(path, '.jsonl');
        const row = this.store.getFile(path);
        const prev = row?.state_json ? JSON.parse(row.state_json) : undefined;
        // 采集器版本落后 → 全量重扫补数据（dedup 幂等，仅一次性成本）
        const needFull = !prev || prev._v !== src.version;
        // mtime 跳过仅用于文件型源（sqlite 的 WAL 写入不改变主文件 mtime），且须版本一致
        const unchanged = row && row.size === s.size && row.mtime_ms === s.mtimeMs;
        if (src.kind !== 'sqlite' && unchanged && !needFull) continue;
        const state = needFull ? undefined : prev;
        const cursor = row?.offset ?? 0;
        const offset = src.kind === 'jsonl'
          ? (needFull || s.size < cursor ? 0 : cursor)
          : 0;

        this.store.db.exec('BEGIN');
        try {
          const r = await COLLECTORS[src.collector](this.store, {
            tool: src.tool, path, fileId, offset, state, version: src.version,
          });
          inserted += r.inserted;
          this.store.saveFile({
            path, tool: src.tool, session_id: fileId, size: s.size,
            mtime_ms: s.mtimeMs,
            offset: src.kind === 'jsonl' ? r.newOffset : 0,
            state_json: r.state ? JSON.stringify(r.state) : null,
          });
          this.store.db.exec('COMMIT');
        } catch (err) {
          this.store.db.exec('ROLLBACK');
          st.parse_errors++;
          st.last_error = `${new Date().toISOString()} ${err.message}`;
          this.log(`parse error ${path}: ${err.message}`);
        }
      }
      this._pruneMissingFiles(src.tool, seen, liveRoots);
    }
    } finally {
      // 必须无条件复位：留在 true 会让之后每一轮扫描都被"并发中"挡掉，面板从此停更
      this.scanning = false;
    }
    this._inheritCodexModels();
    if (!quiet) {
      this.log(`scan: ${files} files, +${inserted} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    if (inserted > 0) this.emit('update');
    return { files, inserted };
  }

  /**
   * 清理已消失文件的游标行（真实库两天就攒下 40 条，且会让健康自检的文件数长期虚高）。
   * 只清"所属 root 当前存在"的路径；只删 files 行，绝不动 events——历史用量必须保留。
   * 文件若日后回来，dedup 保证重新解析是幂等的。
   */
  _pruneMissingFiles(tool, seen, liveRoots) {
    if (!liveRoots.length) return 0;
    const db = this.store.db;
    const rows = db.prepare('SELECT path FROM files WHERE tool = ?').all(tool);
    const gone = rows.filter(r => !seen.has(r.path) && liveRoots.some(root => r.path.startsWith(root)));
    if (!gone.length) return 0;
    const del = db.prepare('DELETE FROM files WHERE path = ?');
    db.exec('BEGIN');
    try {
      for (const g of gone) del.run(g.path);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      this.log(`prune ${tool}: ${err.message}`);
      return 0;
    }
    return gone.length;
  }

  /**
   * Codex 模型补全（两步）：
   * 1. resume 链继承：续写文件自身无模型记录，按 parent_thread_id 继承父的最终模型；
   * 2. 事件回填：dedup 只防重插不更新旧行——state.model 已知但事件为 null 的，UPDATE 补写。
   */
  _inheritCodexModels() {
    const db = this.store.db;
    const rows = db.prepare("SELECT * FROM files WHERE tool = 'codex'").all();
    // files.session_id 是完整 stem（rollout-时间-<uuid>），parent_thread_id 是裸 uuid → 按尾部 36 位匹配
    const uuidOf = (sid) => (sid || '').slice(-36);
    const byUuid = new Map(rows.map(r => [uuidOf(r.session_id), r]));
    const updState = db.prepare(
      "UPDATE events SET model = ? WHERE tool = 'codex' AND session_id = ? AND model IS NULL");
    const states = new Map();
    for (const r of rows) {
      try { states.set(r.session_id, r.state_json ? JSON.parse(r.state_json) : null); } catch { states.set(r.session_id, null); }
    }
    let changed = true, passes = 0;
    while (changed && passes++ < 6) {
      changed = false;
      for (const [sid, st] of states) {
        if (!st || st.model || !st.parent) continue;
        const pst = states.get(byUuid.get(st.parent)?.session_id ?? '') ?? null;
        if (!pst?.model) continue;
        st.model = pst.model;
        changed = true;
      }
    }
    // 统一回填事件 + 持久化 state
    for (const r of rows) {
      const st = states.get(r.session_id);
      if (!st) continue;
      if (st.model) updState.run(st.model, r.session_id);
      this.store.saveFile({ ...r, state_json: JSON.stringify(st) });
    }
  }

  /** FSEvents 监听 + 防抖 + 周期兜底扫描 */
  startWatching() {
    for (const src of SOURCES) {
      for (const root of src.roots) {
        // sqlite 源：WAL 写入不改变主文件，必须监听父目录才能收到 -wal 变更事件
        const watchDir = src.kind === 'sqlite' ? dirname(root) : root;
        // 目录不存在 = 用户没装这个工具，属正常情况，不该刷一行 watch failed 吓人
        if (!existsSync(watchDir)) continue;
        try {
          const w = watchCb(watchDir, { recursive: true }, () => this._scheduleScan());
          this._watchers.push(w);
        } catch {
          try {
            const w = watchCb(watchDir, () => this._scheduleScan());
            this._watchers.push(w);
          } catch (err) {
            this.log(`watch failed ${watchDir}: ${err.message}`);
          }
        }
      }
    }
    this._intervalTimer = setInterval(() => this._scheduleScan(), 60_000);
    this._intervalTimer.unref();
  }

  _scheduleScan() {
    if (this._debounceTimer) return;
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      // 定时器回调里的 rejection 无人接手 = 未处理 rejection = 进程退出，必须就地收敛
      this.scanAll({ quiet: true }).catch(err => this.log(`scan failed: ${err?.message ?? err}`));
    }, 800);
    this._debounceTimer.unref();
  }

  stop() {
    for (const w of this._watchers) w.close();
    if (this._intervalTimer) clearInterval(this._intervalTimer);
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
  }
}
