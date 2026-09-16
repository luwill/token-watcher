import { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import { normalizeModel } from '../models.js';

/**
 * OpenCode 采集器：直接读 `opencode.db`（只读，可与其 WAL 并发）。
 *
 * - `message` 表逐条 assistant 消息 = 一次 API 调用；用量在 `data` 这列 JSON 的 `tokens`
 *   （实测：session 表的 tokens_* 聚合列 == 各 message 之和，故 message 级不重不漏）。
 * - `part` 表 `data.type='tool'` 是工具调用。
 * - 两张表各自用 rowid 水位增量；dedup_key 兜底幂等（版本升级触发全量重扫时不会重复计数）。
 *
 * 口径：`tokens.total = input + output + cache.read + cache.write`，
 * 即 input 不含缓存、reasoning 已含在 output 内——与 Pi 相同，与库内公式同构。
 */
export async function collectOpencodeDb(store, { tool, path, state, version }) {
  const st = { maxRowid: 0, partMaxRowid: 0, ...(state ?? {}), _v: version };
  let inserted = 0;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return { inserted, state: st, skip: true }; // db 不存在/被锁：跳过本轮
  }
  try {
    const sessDir = db.prepare('SELECT directory FROM session WHERE id = ?');

    /**
     * rowid 水位在**会删行**的表上不够：OpenCode 的 message/part 是 ON DELETE CASCADE，
     * session 还带 revert——删掉最大 rowid 后 SQLite 会把该号让给下一条插入，
     * 新消息的 rowid 就可能不大于水位，于是被静默跳过（不报错、只是永远少一条）。
     * 表变短就是删过行的信号：把水位退回 0 整表重读，dedup 保证重读是幂等的。
     */
    const rewindIfShrunk = (table, watermark) => {
      const max = db.prepare(`SELECT MAX(rowid) AS m FROM "${table}"`).get()?.m ?? 0;
      return max < watermark ? 0 : watermark;
    };
    st.maxRowid = rewindIfShrunk('message', st.maxRowid);
    st.partMaxRowid = rewindIfShrunk('part', st.partMaxRowid);

    const msgs = db.prepare(`
      SELECT rowid AS rid, id, session_id, time_created, data
      FROM message WHERE rowid > ? ORDER BY rowid`).all(st.maxRowid);
    for (const m of msgs) {
      st.maxRowid = Math.max(st.maxRowid, m.rid);
      let d;
      try { d = JSON.parse(m.data); } catch { continue; }
      // user 消息没有 tokens：跳过，不能记成 0 用量的事件
      const t = d?.tokens;
      if (!t || d.role !== 'assistant') continue;

      const ts = Number(d.time?.created) || Number(m.time_created) || 0;
      if (!ts) continue;

      const input = t.input || 0;
      const cached = t.cache?.read || 0;
      const cacheWrite = t.cache?.write || 0;
      const output = t.output || 0;
      const total = input + cached + cacheWrite + output;
      if (total <= 0) continue;

      const dir = sessDir.get(m.session_id)?.directory;
      inserted += store.insertEvent({
        ts,
        tool,
        model: normalizeModel(d.modelID),
        session_id: m.session_id,
        project: dir ? basename(dir) : null,
        input_tokens: input,
        cached_input: cached,
        cache_write: cacheWrite,
        output_tokens: output,
        reasoning_tokens: t.reasoning || 0,
        total_tokens: total,
        dedup_key: `${tool}:${m.id}`,
      });
    }

    const parts = db.prepare(`
      SELECT rowid AS rid, id, session_id, time_created, data
      FROM part WHERE rowid > ? ORDER BY rowid`).all(st.partMaxRowid);
    for (const p of parts) {
      st.partMaxRowid = Math.max(st.partMaxRowid, p.rid);
      let d;
      try { d = JSON.parse(p.data); } catch { continue; }
      if (d?.type !== 'tool' || !d.tool) continue;
      const ts = Number(d.state?.time?.start) || Number(p.time_created) || 0;
      if (!ts) continue;
      store.insertToolCall({
        ts, tool, name: d.tool, session_id: p.session_id,
        dedup_key: `${tool}:tc:${d.callID || p.id}`,
      });
    }
  } finally {
    db.close();
  }
  return { inserted, state: st };
}
