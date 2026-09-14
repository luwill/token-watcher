import { basename } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';

/**
 * Codex rollout 采集器（~/.codex/sessions 与 archived_sessions，2.4GB 量级）。
 *
 * - token_count.info.total_token_usage 是会话累计值：按相邻事件差分得到单次用量，
 *   差分为 0 的事件（重复通知）自然跳过。
 * - 模型名（版本差异，两种都认）：新格式 thread_settings_applied.thread_settings.model；
 *   旧格式 turn_context.payload.model（2026-09 之前的 rollout）。
 * - 工具调用：response_item 且 payload.type=function_call（name/call_id）。
 * - rate_limits 为账号级配额快照：只保留全局最新一条（按 ts）。
 * - 增量恢复：state（累计值 + 当前模型 + 项目）持久化在 files.state_json。
 * - OpenAI 口径：input_tokens 已含 cached_input_tokens，total = input + output。
 */
export async function collectCodexFile(store, { path, fileId, offset, state, version }) {
  let st = state ?? { model: null, cum: null, project: null, seq: 0, parent: null };
  st._v = version; // 版本戳：避免常驻服务每轮全量重扫
  let inserted = 0;

  const { newOffset } = await readLinesFrom(path, offset, (line) => {
    if (!line.includes('"token_count"') &&
        !line.includes('"thread_settings_applied"') &&
        !line.includes('"session_meta"') &&
        !line.includes('"turn_context"') &&
        !line.includes('"function_call"')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const payload = rec?.payload;
    if (!payload) return;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;

    if (rec.type === 'session_meta' || payload.type === 'session_meta') {
      // session_meta 的 type 在记录顶层，payload 即 SessionMeta（含 cwd）
      st.project = payload.cwd ? basename(payload.cwd) : st.project;
      st.parent = payload.parent_thread_id || null; // resume 链：模型可从父会话继承
      return;
    }
    if (rec.type === 'turn_context') {
      if (payload.model) st.model = normalizeModel(payload.model); // 旧格式模型位
      return;
    }
    if (rec.type === 'response_item' && payload.type === 'function_call') {
      if (payload.name && Number.isFinite(ts)) {
        store.insertToolCall({
          ts, tool: 'codex', name: payload.name,
          session_id: fileId,
          dedup_key: `codex:tc:${path}:${payload.call_id ?? `${st.seq}`}`,
        });
      }
      return;
    }
    if (payload.type === 'thread_settings_applied') {
      st.model = normalizeModel(payload.thread_settings?.model ?? st.model);
      return;
    }
    if (payload.type === 'token_count') {
      const info = payload.info;
      if (!info?.total_token_usage || !Number.isFinite(ts)) return;

      if (payload.rate_limits) {
        const rl = payload.rate_limits;
        store.saveQuota('codex', ts, {
          used_percent: rl.primary?.used_percent ?? null,
          window_minutes: rl.primary?.window_minutes ?? null,
          resets_at: rl.primary?.resets_at ?? null,
          plan_type: rl.plan_type ?? null,
        });
      }

      const t = info.total_token_usage;
      const cur = {
        i: t.input_tokens || 0,
        c: t.cached_input_tokens || 0,
        w: t.cache_write_input_tokens || 0,
        o: t.output_tokens || 0,
        r: t.reasoning_output_tokens || 0,
        tt: t.total_tokens || 0,
      };
      if (!st.cum) { st.cum = cur; return; } // 首个事件只建立基线
      const d = {
        i: cur.i - st.cum.i, c: cur.c - st.cum.c, w: cur.w - st.cum.w,
        o: cur.o - st.cum.o, r: cur.r - st.cum.r, tt: cur.tt - st.cum.tt,
      };
      st.cum = cur;
      if (d.i <= 0 && d.o <= 0 && d.tt <= 0) return; // 无新用量

      const total = d.i > 0 ? d.i + d.o : Math.max(d.tt, 0);
      st.seq++;
      inserted += store.insertEvent({
        ts,
        tool: 'codex',
        model: st.model,
        session_id: payload.session_id || fileId,
        project: st.project,
        input_tokens: Math.max(d.i - d.c, 0), // 新输入 = input - 缓存命中
        cached_input: Math.max(d.c, 0),
        cache_write: Math.max(d.w, 0),
        output_tokens: Math.max(d.o, 0),
        reasoning_tokens: Math.max(d.r, 0),
        total_tokens: total,
        dedup_key: `codex:${path}:${st.seq}`, // 文件内单调序号，重放幂等
      });
    }
  });

  return { newOffset, inserted, state: st };
}
