import { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import { normalizeModel } from '../models.js';

/**
 * ZCode 采集器：直接读 `~/.zcode/cli/db/db.sqlite` 的 model_usage 表（只读，可与其 WAL 并发）。
 *
 * - rowid 水位增量：model_usage 只追加，rowid > 水位 即新行；dedup_key = zcode:{id} 兜底幂等。
 * - 口径（实测 computed_total = input + output 推得）：input_tokens 含 cache_read（OpenAI 风格），
 *   入库时拆为 新输入/缓存命中；total = input + cache_write + output。
 */
export async function collectZcodeDb(store, { path, state, version }) {
  let st = state ?? { maxRowid: 0, toolMaxRowid: 0 };
  st._v = version;
  st.toolMaxRowid ??= 0; // v1 存量 state 无此字段：从 0 补读 tool_usage（dedup 幂等）
  let inserted = 0;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return { inserted, state: st, skip: true }; // db 不存在/被锁：跳过本轮
  }
  try {
    // 工具调用水位（tool_usage 表）
    const tools = db.prepare(`
      SELECT rowid AS rid, session_id, tool_name, started_at FROM tool_usage WHERE rowid > ? ORDER BY rowid`)
      .all(st.toolMaxRowid);
    for (const t of tools) {
      st.toolMaxRowid = Math.max(st.toolMaxRowid, t.rid);
      if (!Number.isFinite(t.started_at) || !t.tool_name) continue;
      store.insertToolCall({
        ts: t.started_at, tool: 'zcode', name: t.tool_name,
        session_id: t.session_id, dedup_key: `zcode:tc:${t.rid}`,
      });
    }

    const sessDir = db.prepare('SELECT directory FROM session WHERE id = ?');
    const rows = db.prepare(`
      SELECT rowid AS rid, id, session_id, provider_id, model_id, started_at,
             input_tokens, output_tokens, reasoning_tokens,
             cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
      FROM model_usage WHERE rowid > ? ORDER BY rowid`).all(st.maxRowid);
    for (const r of rows) {
      st.maxRowid = Math.max(st.maxRowid, r.rid);
      if (!Number.isFinite(r.started_at)) continue;
      const inputRaw = r.input_tokens || 0;
      const cached = Math.min(r.cache_read_input_tokens || 0, inputRaw); // 防御：cached 不超 input
      const cacheWrite = r.cache_creation_input_tokens || 0;
      const output = r.output_tokens || 0;
      const total = inputRaw + cacheWrite + output;
      if (total <= 0) continue;
      const dir = sessDir.get(r.session_id)?.directory;
      inserted += store.insertEvent({
        ts: r.started_at,
        tool: 'zcode',
        model: normalizeModel(r.model_id),
        session_id: r.session_id,
        project: dir ? basename(dir) : null,
        input_tokens: inputRaw - cached,
        cached_input: cached,
        cache_write: cacheWrite,
        output_tokens: output,
        reasoning_tokens: r.reasoning_tokens || 0,
        total_tokens: total,
        dedup_key: `zcode:${r.id}`,
      });
    }
  } finally {
    db.close();
  }
  return { inserted, state: st };
}
