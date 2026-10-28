import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { leveldbValues, unwrapIndexedDbValue, v8PayloadOffset, parseSSV, isLevelTable } from '../v8leveldb.js';
import { normalizeModel } from '../models.js';

/**
 * 豆包 / 豆包工作采集器（同一解析器，两个 SOURCES 条目）。
 *
 * 两个 App 都是 ByteDance 自带 Chromium 内核的桌面壳，聊天与 Agent 任务状态存在
 * ~/Library/Application Support/{Doubao,DoubaoWork}/Default/IndexedDB/chrome_*chat_0.indexeddb.leveldb
 * （LevelDB + V8 structured-clone，解码见 ../v8leveldb.js）。本机实测（2026-10-27，
 * 豆包工作 2.34.1 / 豆包 9 月残留库）唯一的用量信号是任务状态记录里每条机器人回复自带的
 *   state.mainTaskDataMap.<task>.receivedMessages.<message_id>.extra.ext.context_window_usage
 *   = '{"system_prompt":N,"messages":N,"skills":N,"tools":N,"total_window_size":256000}'
 * 四项是本次请求送进模型的上下文 token 拆分（total_window_size 是窗口容量，不是用量）。
 *
 * 口径与边界（都在文档里明示，不做任何估算补全）：
 * - 一条机器人回复 = 一次请求 = 一条事件：input = 四项之和，output/缓存/思维全为 0，
 *   total = input。本地没有输出 token，这是上游不存，不是没解到。
 * - 模型名本地不存，只有内部数字 id（ext.model_id / llm_model_type / model_type，实测 "38"），
 *   记作 doubao-model-<id>：能区分模型但不配价（不虚构成本）。
 * - 时间取 extra.create_time（毫秒 double）；会话 = extra.conversation_id；
 *   去重键 = tool:conversation_id:message_id —— 任务状态记录每轮都整体重写、WAL 与压实后的
 *   .ldb 各存一份、scopes 撤销日志还会留旧副本，全靠这把键收成一条。
 * - 豆包工作里这条记录只在任务进行中存在，任务结束就被删掉；只能靠常驻扫描在 compaction
 *   前从 WAL 里抓到，历史不可追溯。豆包本体（已卸载）的残留库是冻结快照，一次导入。
 * - 值可能被值级 snappy 包装（ff 11 02）或外置到 .indexeddb.blob 目录；两者都认，
 *   但 blob 文件实测目前只放技能/配置大记录，纳入只是防多轮任务状态超 64KB 被外置。
 */

const CWU = Buffer.from('context_window_usage');
const TIME_KEYS = ['create_time_ms', 'create_time', 'createTime', 'update_time_ms', 'querySendTimestamp'];
const CONV_KEYS = ['conversation_id', 'local_conversation_id', 'conversationId'];
const MSG_KEYS = ['message_id', 'local_message_id', 'uniqueId'];
const MODEL_KEYS = ['model_id', 'llm_model_type', 'model_type', 'model_name'];
const PATH_KEYS = ['workspace', 'agent_workspace', 'shared_folder_path', 'folder', 'cwd'];
const PARAM_KEYS = ['general_task_param', 'agent_task_param', 'task_param'];
const MIN_TS = Date.UTC(2023, 0, 1);

/** 'blob' = .indexeddb.blob 目录下的外置值文件；null = 不是我们要读的文件 */
export function doubaoFileKind(path) {
  if (/\.indexeddb\.blob[\\/]/.test(path)) return 'blob';
  const ext = extname(path);
  if (ext === '.log') return 'log';
  if (ext === '.ldb' || ext === '.sst') return 'ldb';
  return null;
}

const nonNegInt = (v) => {
  if (Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v);
  return null;
};

/** context_window_usage（JSON 字串或对象）→ { input, parts }；缺项、非数字、总和为 0 都返回 null */
export function doubaoUsage(raw) {
  let u = raw;
  if (typeof u === 'string') {
    try { u = JSON.parse(u); } catch { return null; }
  }
  if (!u || typeof u !== 'object') return null;
  const parts = {};
  for (const k of ['system_prompt', 'messages', 'skills', 'tools']) {
    const n = nonNegInt(u[k]);
    if (n !== null) parts[k] = n;
  }
  const explicit = nonNegInt(u.total_tokens) ?? nonNegInt(u.used_tokens);
  const input = explicit ?? Object.values(parts).reduce((a, b) => a + b, 0);
  if (!(input > 0) || !Number.isSafeInteger(input)) return null;
  return { input, parts };
}

/** 毫秒/秒/微秒的数字或数字字串 → 毫秒；不在合理区间返回 null */
function toMillis(v) {
  let n = typeof v === 'string' && /^\d{10,16}$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  if (n > 1e14) n = Math.floor(n / 1000);
  else if (n < 1e11) n = Math.floor(n * 1000);
  return n >= MIN_TS && n <= Date.now() + 86_400_000 ? n : null;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && !(v instanceof Map) && !(v instanceof Set) && !(v instanceof Date) && !Buffer.isBuffer(v);

/** 深度优先找出所有直接拥有 key 的对象，返回祖先链（最近者在前）。有环（back-reference）也安全。 */
export function containersWith(root, key) {
  const out = [];
  const seen = new Set();
  const walk = (v, chain) => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const e of v) walk(e, chain); return; }
    if (v instanceof Map || v instanceof Set) { for (const e of v.values()) walk(e, chain); return; }
    if (!isPlain(v)) return;
    const next = [v, ...chain];
    if (Object.hasOwn(v, key)) out.push(next);
    for (const k in v) walk(v[k], next);
  };
  walk(root, []);
  return out;
}

/** 按对象顺序、键顺序取第一个满足条件的直接属性值 */
function firstScalar(objs, keys, accept) {
  for (const o of objs) {
    for (const k of keys) {
      if (!Object.hasOwn(o, k)) continue;
      const v = accept(o[k]);
      if (v !== null && v !== undefined) return v;
    }
  }
  return null;
}

const idString = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
};

const isAbsPath = (s) => typeof s === 'string' && (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) && s.length > 1;

function pathInside(v, depth) {
  if (depth > 4 || v === null || typeof v !== 'object' || !(Array.isArray(v) || isPlain(v))) return null;
  for (const k of PATH_KEYS) if (isAbsPath(v[k])) return v[k];
  for (const k in v) {
    const r = pathInside(v[k], depth + 1);
    if (r) return r;
  }
  return null;
}

/** project = 工作目录末段：直接属性里的绝对路径，或 *_task_param JSON 字串里的 */
function projectOf(objs) {
  for (const o of objs) {
    const direct = pathInside(o, 4);
    if (direct) return basename(direct.replace(/[\\/]+$/, ''));
    for (const k of PARAM_KEYS) {
      if (typeof o[k] !== 'string') continue;
      let parsed;
      try { parsed = JSON.parse(o[k]); } catch { continue; }
      const p = pathInside(parsed, 0);
      if (p) return basename(p.replace(/[\\/]+$/, ''));
    }
  }
  return null;
}

function modelOf(objs) {
  const raw = firstScalar(objs, MODEL_KEYS, idString);
  if (!raw) return null;
  return /^\d+$/.test(raw) ? `doubao-model-${raw}` : normalizeModel(raw);
}

const digest = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** 一棵已反序列化的 IndexedDB 记录树 → 事件列表（可能为空，也可能多条：一个任务多轮回复） */
export function doubaoEvents(root, tool) {
  const events = [];
  for (const chain of containersWith(root, 'context_window_usage')) {
    const [ext] = chain;
    const usage = doubaoUsage(ext.context_window_usage);
    if (!usage) continue;
    const ts = firstScalar(chain, TIME_KEYS, toMillis);
    if (ts === null) continue; // 没有时间就无法落图：不编造
    const conversation = firstScalar(chain, CONV_KEYS, idString);
    const cwuText = typeof ext.context_window_usage === 'string' ? ext.context_window_usage : JSON.stringify(ext.context_window_usage);
    const identity = firstScalar(chain, MSG_KEYS, idString) ?? digest(cwuText);
    events.push({
      ts,
      tool,
      model: modelOf(chain.slice(0, 2)),
      session_id: conversation ?? identity,
      project: projectOf(chain),
      input_tokens: usage.input,
      cached_input: 0,
      cache_write: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: usage.input,
      dedup_key: `${tool}:${conversation ?? '-'}:${identity}`,
    });
  }
  return events;
}

export async function collectDoubaoFile(store, { tool, path }) {
  const kind = doubaoFileKind(path);
  if (!kind) return { newOffset: 0, inserted: 0 };
  const buf = await readFile(path);
  let inserted = 0, undecodable = 0;
  let values;
  if (kind === 'blob') values = [buf];
  else if (kind === 'ldb' && !isLevelTable(buf)) values = []; // compaction 正在写：下一轮 mtime 变了再读
  else values = leveldbValues(buf, kind);
  for (const raw of values) {
    let bytes;
    try { bytes = unwrapIndexedDbValue(raw, kind !== 'blob'); } catch { undecodable++; continue; }
    if (!bytes || !bytes.includes(CWU)) continue; // 快筛必须在解包之后：压缩值里看不到明文
    let root;
    try {
      const off = v8PayloadOffset(bytes);
      if (off < 0) continue;
      root = parseSSV(bytes, off).value;
    } catch { undecodable++; continue; } // scopes 撤销日志等非对象存储值：旧副本，去重后本就无贡献
    for (const ev of doubaoEvents(root, tool)) inserted += store.insertEvent(ev);
  }
  return { newOffset: 0, inserted, undecodable };
}
