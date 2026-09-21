import { basename, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';
import { HOME } from '../config.js';

/**
 * Kimi Code CLI（官方 @moonshot-ai/kimi-code）采集器：
 * ~/.kimi-code/sessions/<wd 目录>/session_<uuid>/agents/<agent>/wire.jsonl
 *
 * - 逐轮用量在 `context.append_loop_event` 包着的 `step.end` 事件上（proto 0.6+ 顶层 type
 *   命名空间）；`usage.record` 与 step.end 携带同一份数据，只读 step.end，读两处会双计；
 * - usage 双形状（跨版本）：camelCase（inputOther 已是新输入，不含缓存）为主，
 *   Anthropic 风格兜底（input_tokens_details.cached_tokens 需减去，防缓存双计）；
 * - 模型在文件头部 config.update 的 modelAlias（"kimi-code/k3" → k3），随 state 存活；
 * - 时间戳在顶层 entry.time（epoch 毫秒）；
 * - 项目名来自 ~/.kimi-code/workspaces.json（wd 目录键 → name），不存在则留空。
 */
const FALLBACK_MODEL = 'kimi-for-coding';

const alias = (v) => (typeof v === 'string' && v ? (v.includes('/') ? v.split('/').pop() : v) : null);

let wsCache = null; // workspaces.json（进程内缓存，文件变化罕见）
async function projectNameOf(wdKey) {
  try {
    if (!wsCache) {
      wsCache = JSON.parse(await readFile(join(HOME, '.kimi-code', 'workspaces.json'), 'utf8')).workspaces || {};
    }
    return wsCache[wdKey]?.name || null;
  } catch { return null; }
}

const nn = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

export async function collectKimiFile(store, { tool, path, offset, state, version }) {
  let st = state ?? { model: null };
  st._v = version;
  let inserted = 0;

  // sessions/<wd>/session_<uuid>/agents/<agent>/wire.jsonl
  const agentsDir = dirname(path);            // …/agents/<agent>
  const sessionDir = dirname(agentsDir);      // …/session_<uuid>
  const wdDir = dirname(dirname(sessionDir)); // …/<wd_key>
  const sessionId = basename(sessionDir);
  const project = await projectNameOf(basename(wdDir));

  const { newOffset } = await readLinesFrom(path, offset, (line) => {
    let e;
    try { e = JSON.parse(line); } catch { return; }

    if (e.type === 'config.update') {
      st.model = alias(e.modelAlias) ?? st.model;
      return;
    }
    const evt = e.type === 'context.append_loop_event' && e.event && typeof e.event === 'object'
      ? e.event : e;
    if (!evt || evt.type !== 'step.end') return;
    const u = evt.usage;
    if (!u || typeof u !== 'object') return;
    const id = evt.uuid;
    if (!id) return;

    let input, cached, cacheW, output;
    if (u.inputOther != null) {
      input = nn(u.inputOther);
      cached = nn(u.inputCacheRead);
      cacheW = nn(u.inputCacheCreation);
      output = nn(u.output);
    } else {
      cacheW = nn(u.cache_creation_input_tokens);
      if (u.cache_read_input_tokens != null) {
        cached = nn(u.cache_read_input_tokens);
        input = nn(u.input_tokens);
      } else {
        // OpenAI 兼容形状：cached 折在 input_tokens 里，单独减出，防双计
        cached = nn(u.input_tokens_details?.cached_tokens);
        input = Math.max(0, nn(u.input_tokens) - cached);
      }
      output = nn(u.output_tokens);
    }
    if (input + cached + cacheW + output <= 0) return;
    const ms = Number(e.time ?? evt.time);
    if (!Number.isFinite(ms)) return;

    inserted += store.insertEvent({
      ts: ms,
      tool,
      model: normalizeModel(st.model ?? FALLBACK_MODEL),
      session_id: sessionId,
      project,
      input_tokens: input,
      cached_input: cached,
      cache_write: cacheW,
      output_tokens: output,
      reasoning_tokens: 0,
      total_tokens: input + cached + cacheW + output,
      dedup_key: `kimi:${id}`,
    });
  });

  return { newOffset, inserted, state: st };
}
