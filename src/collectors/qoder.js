import { basename } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';

/**
 * Qoder 采集器：~/.qoder/projects/<编码目录>/<session>.jsonl（Anthropic Messages 形状，
 * 与 Claude Code transcript 同构；Qoder CN 用 ~/.qoder-cn/projects 姊妹目录）。
 *
 * **本机实测（2026-09-20，qmodel_38max）：assistant 行的 usage 四项全为 0，真实消耗只
 * 落在 credits 字段**（original_credits 为折前值）。与 TokenTracker 的取舍一致：
 * 有真实 token 的行才入事件（上游将来恢复上报即自动生效），credits 不折算 token——
 * 没有官方兑换率，编造即失真。credits 走独立的 credit_usage 账本，面板出"积分消耗"卡。
 *
 * - 同一 message.id 会按 content block 拆多行（thinking 行无 usage，终结行带 usage），
 *   dedup 走 store 既有的"输出更大者补齐"语义（与 ccmr 同坑同防）；
 * - BYOK 模型 id 形如 "qoder-custom-<uuid>/glm-5.3-flash"：剥安装期前缀，模型键跨重装稳定；
 * - cwd 在 workspace-directories 行（转录首部）：project 取末段目录名。
 */

const CUSTOM_PREFIX = /^qoder-custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

export function qoderModelOf(raw) {
  const m = typeof raw === 'string' ? raw.trim().replace(CUSTOM_PREFIX, '') : '';
  return m ? normalizeModel(m) : 'qoder-agent';
}

export async function collectQoderFile(store, { tool, path, fileId, offset }) {
  let inserted = 0;
  let credits = 0;
  let project = null;

  const { newOffset } = await readLinesFrom(path, offset, (line) => {
    if (!line.includes('"assistant"') && !line.includes('workspace-directories')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    if (rec.type === 'workspace-directories' && Array.isArray(rec.directories) && rec.directories[0]) {
      project = basename(rec.directories[0]);
      return;
    }
    const msg = rec?.message;
    if (rec?.type !== 'assistant' || !msg?.id) return;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isFinite(ts)) return;

    const usage = msg.usage;
    if (!usage || typeof usage !== 'object') return; // thinking 等前置分片

    // 积分账本：credits 为实耗（折后），original_credits 为折前；无 credits 字段的部署跳过
    const cr = Number(usage.credits ?? 0);
    if (Number.isFinite(cr) && cr > 0) {
      credits += store.insertCredit({
        ts, tool, amount: cr, dedup_key: `qoder-credit:${msg.id}`,
      }) ? cr : 0;
    }

    const input = usage.input_tokens || 0;
    const cached = usage.cache_read_input_tokens || 0;
    const cacheW = usage.cache_creation_input_tokens || 0;
    const output = usage.output_tokens || 0;
    if (input + cached + cacheW + output <= 0) return; // 上游只报 credits 的行：不入 token 事件

    inserted += store.insertEvent({
      ts,
      tool,
      model: qoderModelOf(msg.model),
      session_id: rec.sessionId || fileId,
      project,
      input_tokens: input,
      cached_input: cached,
      cache_write: cacheW,
      output_tokens: output,
      reasoning_tokens: 0,
      total_tokens: input + cached + cacheW + output,
      dedup_key: `${tool}:${msg.id}:${usage.request_id ?? ''}`,
    });
  });

  return { newOffset, inserted, credits, state: { _v: 1 } };
}
