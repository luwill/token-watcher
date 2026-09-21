import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';

/**
 * Antigravity（IDE / antigravity-cli）采集器：估算口径，非逐请求实数。
 *
 * 本地没有任何一处落"逐请求 usage"——这是 2026-09 初次调研的结论，本次复核在
 * conversations/*.db 的 gen_metadata 里找到了部分实数（上下文窗口大小），据此采用
 * 与社区实测实现 TokenTracker（MIT）相同的估算法：
 *   - transcript：~/.gemini/antigravity{,-cli,-ide}/brain/<uuid>/.system_generated/logs/transcript.jsonl
 *     有完整对话流但无 usage，按 PLANNER_RESPONSE（每次 planner 调用）计费；
 *   - 输入 = 真实上下文增量：gen_metadata 的 protobuf（字段 1 → 9 → 10 → 1）带该轮的
 *     contextTokens（含系统提示与技能清单，transcript 里没有，按内容估会严重偏低），
 *     相邻两次 planner 的上下文差即新输入（防 O(N²) 重复计整段历史）；无 db 行时回落
 *     字符估算；换模型时 prevCtx 清零（新会话基线）；
 *   - 输出/思维链 = 字符估算（CJK×1 + 其他×¼），上游不落 token 数，这是本地可得的最优口径；
 *   - 模型：db 字段 19 > 用户切换消息 > variant 根目录 settings.json 默认值。
 *
 * db 行与 transcript 行几乎同时落盘，但存在晚到窗口：先按估算入账的事件记进
 * state.pending，后续任一轮扫描拿到权威 contextTokens 后原地 UPDATE 补正（dedup
 * 只防重插不更新，不补正就会把"第一眼的低估"钉死）。
 */

/* ---------- 极简 protobuf 扫描（只需 varint 与 length-delimited 两类） ---------- */

function readVarint(b, o) {
  let v = 0, s = 0;
  while (o < b.length) {
    const x = b[o++];
    v |= (x & 0x7f) << s;
    if (!(x & 0x80)) return [v, o];
    s += 7;
    if (s > 63) throw new Error('varint too long');
  }
  throw new Error('varint truncated');
}

function protoFields(buf) {
  const out = [];
  let o = 0;
  try {
    while (o < buf.length) {
      const [tag, next] = readVarint(buf, o);
      o = next;
      const num = tag >> 3, wt = tag & 7;
      if (wt === 0) {
        const [v, vNext] = readVarint(buf, o);
        o = vNext;
        out.push({ num, val: v });
      } else if (wt === 2) {
        const [len, lNext] = readVarint(buf, o);
        o = lNext;
        out.push({ num, val: buf.subarray(o, o + len) });
        o += len;
      } else if (wt === 1) o += 8;
      else if (wt === 5) o += 4;
      else break;
    }
  } catch { /* 截断的尾部：已解析的前缀仍可用 */ }
  return out;
}

const utf8 = (v) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : null);

/** gen_metadata 行 → { model, contextTokens, lastStepIndex }；结构不认识返回 null */
export function extractGenInfo(buf) {
  if (!(buf instanceof Uint8Array) || buf.length === 0) return null;
  const f1 = protoFields(buf).find((f) => f.num === 1)?.val;
  if (!(f1 instanceof Uint8Array)) return null;
  const inner = protoFields(f1);

  const model = utf8(inner.find((f) => f.num === 19)?.val)?.trim() || null;

  let contextTokens = 0;
  const f9 = inner.find((f) => f.num === 9)?.val;
  if (f9 instanceof Uint8Array) {
    const f10 = protoFields(f9).find((f) => f.num === 10)?.val;
    if (f10 instanceof Uint8Array) {
      const tok = protoFields(f10).find((f) => f.num === 1)?.val;
      if (Number.isFinite(tok)) contextTokens = tok;
    }
  }

  let lastStepIndex = null;
  for (const f of inner) {
    if (f.num !== 20 || !(f.val instanceof Uint8Array)) continue;
    const kv = protoFields(f.val);
    const k = utf8(kv.find((x) => x.num === 1)?.val);
    const v = utf8(kv.find((x) => x.num === 2)?.val);
    if (k === 'last_step_index' && v != null) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) lastStepIndex = n;
    }
  }
  return { model, contextTokens, lastStepIndex };
}

/** conversations/<uuid>.db 的 gen_metadata → Map(该 gen 行覆盖到的下一步 step_index → 信息) */
function readGenMetadata(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null; // db 不存在/被锁：全部走字符估算
  }
  try {
    let rows;
    try {
      rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all();
    } catch {
      return null; // 旧版本库无此表
    }
    const map = new Map();
    for (const r of rows) {
      const info = extractGenInfo(r.data);
      if (info && info.lastStepIndex != null && info.contextTokens > 0) {
        map.set(info.lastStepIndex + 1, info);
      }
    }
    return map.size > 0 ? map : null;
  } finally {
    db.close();
  }
}

/* ---------- 字符估算与模型名 ---------- */

const isCjk = (cp) => (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf)
  || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x20000 && cp <= 0x2ffff);

export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0, other = 0;
  for (const ch of text) (isCjk(ch.codePointAt(0)) ? cjk++ : other++);
  return cjk + Math.ceil(other / 4);
}

const estValue = (v) => (typeof v === 'string' ? estimateTokens(v)
  : v == null ? 0 : estimateTokens(safeJson(v)));
function safeJson(v) { try { return JSON.stringify(v); } catch { return ''; } }

/** 一步自身新产生的 token 量（响应/工具调用会成为下一轮的历史上下文） */
const estStep = (r) => {
  let t = estValue(r.content);
  if (r.type === 'PLANNER_RESPONSE') t += estValue(r.tool_calls);
  return t;
};

/** "changed setting `Model Selection` from X to Gemini 3.8 Flash (Medium)." → 规范 slug */
export function normalizeAntigravityModel(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  let slug = name.trim()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(thinking|xhigh|high|medium|low|fast)\b/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!slug) return null;
  for (const marker of ['gemini', 'claude', 'gpt']) {
    const i = slug.indexOf(marker);
    if (i >= 0) { slug = slug.slice(i); break; }
  }
  return /^(gemini|claude|gpt)-/.test(slug) ? slug : `antigravity-${slug}`;
}

function parseModelSelection(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(/changed setting `Model Selection` from .*? to ([^`\n]+?)(?:\s*\([^)]*\))?\.(?:\s+|$)/i);
  return m ? normalizeAntigravityModel(m[1]) : null;
}

/* ---------- 路径推导 ---------- */

/** …/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl → variant 根 */
export function variantRootOf(transcriptPath) {
  const m = transcriptPath.match(/^(.*)[/\\]brain[/\\][^/\\]+[/\\]\.system_generated[/\\]logs[/\\]transcript.*\.jsonl$/);
  return m ? m[1] : null;
}

export function sessionUuidOf(transcriptPath) {
  const m = transcriptPath.match(/[/\\]brain[/\\]([^/\\]+)[/\\]/);
  return m ? m[1] : null;
}

/* ---------- 采集主流程 ---------- */

export async function collectAntigravityFile(store, { tool, path, fileId, offset, state, version }) {
  let st = state ?? { ctx: 0, prevCtx: 0, model: null, lastPlannerModel: null, pending: [], seen: [] };
  st._v = version;
  st.pending ??= [];
  st.seen ??= [];
  let inserted = 0;
  // 上游会把历史行重放/重写进 transcript（实测同一段 step 整块出现两遍）。重放行若照常
  // 处理会双重 inflate 上下文、且差分出的 input=0 会经补正通道覆盖原计费——必须整体跳过。
  const seen = new Set(st.seen);

  const root = variantRootOf(path);
  const uuid = sessionUuidOf(path) ?? fileId;
  const sid = `anty-${uuid}`;

  const stepMap = root ? readGenMetadata(join(root, 'conversations', `${uuid}.db`)) : null;

  // variant 根的 settings.json 是模型兜底（每次现读：用户会改默认模型）
  if (!st.model && root) {
    try {
      const s = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
      if (typeof s.model === 'string') st.model = normalizeAntigravityModel(s.model);
    } catch { /* 无 settings / 解析失败 */ }
  }

  // 补正上一轮按估算入账的事件：权威 contextTokens 到位后原地 UPDATE。
  // 语句统一：total 用库里的 output/reasoning 重算（SQLite 的 SET 右值取旧行列，
  // 不会受同行 input 赋值影响）。
  const updAuthentic = store.db.prepare(
    'UPDATE events SET input_tokens = ?, total_tokens = ? + output_tokens + reasoning_tokens WHERE dedup_key = ?');
  if (st.pending.length && stepMap) {
    for (let i = st.pending.length - 1; i >= 0; i--) {
      const p = st.pending[i];
      const info = stepMap.get(p.step);
      if (!info || !(info.contextTokens > 0)) continue;
      // 该轮新输入 = 权威上下文 - 计费时的基线（与实时路径同式）
      const newInput = Math.max(0, info.contextTokens - p.prevCtx);
      updAuthentic.run(newInput, newInput, p.key);
      st.pending.splice(i, 1);
    }
  }

  const { newOffset } = await readLinesFrom(path, offset, (line) => {
    let r;
    try { r = JSON.parse(line); } catch { return; }
    if (!r || typeof r !== 'object') return;

    // 重放的历史行：跳过（step_index 单调递增，重复出现即重放）
    const si = r.step_index;
    if (Number.isFinite(si)) {
      if (seen.has(si)) return;
      seen.add(si);
      st.seen.push(si);
      if (st.seen.length > 4000) st.seen = st.seen.slice(-2000); // 防 state 无界（超长会话截尾）
    }

    if (r.type === 'USER_INPUT' || r.type === 'USER_SETTINGS_CHANGE') {
      st.model = parseModelSelection(r.content) ?? st.model;
    }

    if (r.type !== 'PLANNER_RESPONSE') {
      st.ctx += estStep(r);
      return;
    }

    const ts = Date.parse(r.created_at);
    const info = stepMap?.get(r.step_index) ?? null;
    if (info?.model) st.model = normalizeAntigravityModel(info.model) ?? st.model;
    st.ctx += estStep(r); // 先把本步自身产出计入历史（下一轮的上下文含本轮响应）
    if (!Number.isFinite(ts)) return;

    // 权威上下文覆盖估算累计（含 transcript 里没有的系统提示与技能清单）
    const ctx = info?.contextTokens > 0 ? info.contextTokens : st.ctx - estStep(r);
    if (st.lastPlannerModel && st.model && st.model !== st.lastPlannerModel) st.prevCtx = 0;
    const input = Math.max(0, ctx - st.prevCtx);
    const output = estValue(r.content) + estValue(r.tool_calls);
    const reasoning = estValue(r.thinking);
    const total = input + output + reasoning;
    if (total <= 0) return;

    const key = `antigravity:${sid}:${r.step_index}`;
    const n = store.insertEvent({
      ts,
      tool,
      model: st.model ? normalizeModel(st.model) : null,
      session_id: sid,
      project: null,
      input_tokens: input,
      cached_input: 0,
      cache_write: 0,
      output_tokens: output,
      reasoning_tokens: reasoning,
      total_tokens: total,
      dedup_key: key,
    });
    inserted += n;
    // 全量重放（版本升级触发）时 dedup 命中旧行：若本次拿到权威 db 值，就地把旧估算补正
    if (n === 0 && info) updAuthentic.run(input, input, key);
    st.prevCtx = ctx;
    st.lastPlannerModel = st.model;
    // 无权威 db 行的入账留待补正（有 50 条上限，防 state 无界增长）
    if (!info && st.pending.length < 50 && input > 0) {
      st.pending.push({ key, step: r.step_index, prevCtx: ctx - input });
    }
  });

  return { newOffset, inserted, state: st };
}
