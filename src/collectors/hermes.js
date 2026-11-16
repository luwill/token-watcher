import { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeModel } from '../models.js';

/**
 * Hermes Agent 采集器：只读 `~/.hermes/state.db`（可与其 WAL 并发）。
 *
 * 数据形态（实测 2026-11-16，Hermes profile=default）——与其它源都不同，接入前必读：
 *
 *  1. `session_model_usage` 不是逐请求事件，而是**按 (session, model, provider, task,
 *     billing_mode, billing_base_url) 聚合、原地累加更新**的行：api_call_count 与各 token
 *     列都是"该聚合自首次以来的累计值"，每次新请求把对应行 UPDATE 上去（last_seen 前移）。
 *     实测 175 行、messages.token_count 全 0、逐请求粒度在库里不存在。
 *     → 因此本源粒度诚实标注为**会话×模型×任务级聚合**，无法 drill 到单次请求。
 *       这不是实现缺陷，是上游只暴露到这个粒度（与 Qoder 只报 credits 同理：如实呈现，不造假）。
 *
 *  2. 正因为"先插后改、原地累加"，必须按 **last_seen 时间水位**增量，不能用 rowid
 *     （同 OpenCode message 表的教训：rowid 水位会越过"已插入未完成"的行）。
 *     每轮回看 LOOKBACK 兜住乱序提交。
 *
 *  3. dedup_key 取聚合身份的**稳定哈希**（不含数值）：同一聚合行每轮被重读时命中同一条
 *     event，由 store.insertEvent 的"输出更大的后来者补齐"语义把累计快照刷新到最新值，
 *     既不重复计数、又能跟随上游增长。
 *
 * 口径：与库内统一公式一致 —— total = input + cached_input + cache_write + output，
 * reasoning_tokens 只作信息列**不再加进 total**（Hermes 单列 reasoning，已含在 output 内）。
 * input_tokens 取 Anthropic 口径（不含 cache_read）；这是接入时唯一需对账验证的假设，
 * 若某 provider 的 input 已含缓存，应在本文件按 billing_provider 分支扣减（暂未发现）。
 */

const LOOKBACK_MS = 60_000; // last_seen 回看窗，兜多写入方乱序提交（同 OpenCode）

/** 聚合身份 → 稳定 dedup_key（数值变化不改键，才能命中"补齐"而非新插一行） */
function aggKey(r) {
  const id = [r.session_id, r.model, r.billing_provider, r.task, r.billing_mode, r.billing_base_url]
    .map(x => (x == null ? '' : String(x))).join('\u0000');
  return 'hermes:smu:' + createHash('sha1').update(id).digest('hex').slice(0, 20);
}

export async function collectHermesDb(store, { tool, path, state, version }) {
  const st = { smuLastSeen: 0, msgMaxRowid: 0, ...(state ?? {}), _v: version };
  let inserted = 0;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return { inserted, state: st, skip: true }; // 库不存在/被锁：跳过本轮（用户没装 Hermes）
  }
  try {
    // 项目名来自 sessions.cwd（实测覆盖率约半数；缺失则 null，不靠目录名猜）
    const sessCwd = db.prepare('SELECT cwd FROM sessions WHERE id = ?');

    // Node 22.13 的 iterator 需持有 statement 强引用，防 GC 提前释放（同 OpenCode）
    const iterate = (sql, ...params) => {
      const statement = db.prepare(sql);
      const rows = statement.iterate(...params);
      Object.defineProperty(rows, 'statementRef', { value: statement });
      return rows;
    };

    // ---- 用量事件：session_model_usage 按 last_seen 水位增量 ----
    // last_seen 是 epoch 秒（real）；events.ts 是毫秒整数。
    const since = Math.max(0, (st.smuLastSeen || 0) - LOOKBACK_MS / 1000);
    const rows = iterate(`
      SELECT session_id, model, billing_provider, billing_mode, billing_base_url, task,
             api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             reasoning_tokens, last_seen
      FROM session_model_usage
      WHERE last_seen > ? ORDER BY last_seen`, since);
    for (const r of rows) {
      const lastSeen = Number(r.last_seen) || 0;
      if (lastSeen > st.smuLastSeen) st.smuLastSeen = lastSeen;

      const input = r.input_tokens || 0;
      const cached = r.cache_read_tokens || 0;
      const cacheWrite = r.cache_write_tokens || 0;
      const output = r.output_tokens || 0;
      const reasoning = r.reasoning_tokens || 0;
      const total = input + cached + cacheWrite + output; // reasoning 不重复计入
      if (total <= 0) continue; // 空调用/中断行不入事件

      const cwd = sessCwd.get(r.session_id)?.cwd;
      inserted += store.upsertHermesEvent({
        ts: Math.round(lastSeen * 1000),
        tool,
        model: normalizeModel(r.model),
        session_id: r.session_id,
        project: cwd ? basename(cwd) : null,
        input_tokens: input,
        cached_input: cached,
        cache_write: cacheWrite,
        output_tokens: output,
        reasoning_tokens: reasoning, // 信息列
        total_tokens: total,
        dedup_key: aggKey(r),
      });
    }

    // ---- 工具调用：messages.tool_name 非空行，按 rowid 水位 + 删行检测 ----
    // messages.id == rowid（实测 0 不一致），但 id 稀疏（max 45918 / 17723 行）说明会删行：
    // 删掉最大 rowid 后号会被复用，纯 rowid 水位会静默漏掉复用的新行（同 OpenCode part 教训）。
    // 表变短即删过行 → 水位退回 0 整表重读，dedup 保证幂等。
    const msgTop = db.prepare('SELECT MAX(rowid) AS m FROM messages').get()?.m ?? 0;
    if (msgTop < st.msgMaxRowid) st.msgMaxRowid = 0;
    const tools = iterate(`
      SELECT rowid AS rid, id, session_id, tool_name, timestamp
      FROM messages
      WHERE rowid > ? AND rowid <= ? AND tool_name IS NOT NULL AND tool_name <> ''
      ORDER BY rowid`, st.msgMaxRowid, msgTop);
    for (const t of tools) {
      const ts = Math.round((Number(t.timestamp) || 0) * 1000);
      if (!ts || !t.tool_name) continue;
      store.insertToolCall({
        ts, tool, name: t.tool_name, session_id: t.session_id,
        dedup_key: `hermes:tc:${t.id}`,
      });
    }
    st.msgMaxRowid = Math.max(st.msgMaxRowid, msgTop);
  } finally {
    db.close();
  }
  return { inserted, state: st };
}
