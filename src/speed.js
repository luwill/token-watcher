/**
 * 模型测速：把带 duration_ms 的事件按模型汇总成耗时与输出速度。纯函数，不做 I/O。
 *
 * duration_ms 的来源与精度见 docs/ARCHITECTURE.md「模型测速」：Claude Code / ccmr 是实测
 * （请求发出 → 末个 content block 落盘），Codex 是推算（触发事件 → token_count），故标 approx。
 */

/** 输出不足这么多 token 的请求只计入耗时，不计入速度：几个 token 除以网络往返得到的数没有意义 */
export const MIN_OUTPUT_FOR_TPS = 20;
/** 推算出的耗时只在这个区间内才可信（采集端已过滤，这里再兜一次底） */
export const MIN_DURATION_MS = 1;
export const MAX_DURATION_MS = 15 * 60_000;
/** 只有这些来源的耗时是推算值 */
const APPROX_TOOLS = new Set(['codex']);

/**
 * 有序数组的分位数（最近秩法：p90 取第 ceil(0.9n) 个，取到真实样本而非插值）。
 * @param {number[]} sorted 升序
 * @param {number} p 0..1
 * @returns {number|null}
 */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (p === 0.5 && sorted.length % 2 === 0) {
    const i = sorted.length / 2;
    return (sorted[i - 1] + sorted[i]) / 2;
  }
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

/**
 * @param {{model: string|null, tool: string, output_tokens: number, duration_ms: number|null}[]} rows
 * @returns {{model: string, tools: string[], approx: boolean, requests: number, speed_samples: number,
 *   median_tps: number|null, p90_tps: number|null, median_ms: number|null, p90_ms: number|null}[]}
 *   按请求数降序
 */
export function modelSpeed(rows) {
  const byModel = new Map();
  for (const r of rows) {
    const d = r.duration_ms;
    if (!r.model || typeof d !== 'number' || !(d >= MIN_DURATION_MS && d <= MAX_DURATION_MS)) continue;
    if (!byModel.has(r.model)) byModel.set(r.model, { tools: new Set(), ms: [], tps: [] });
    const m = byModel.get(r.model);
    m.tools.add(r.tool);
    m.ms.push(d);
    if ((r.output_tokens || 0) >= MIN_OUTPUT_FOR_TPS) m.tps.push(r.output_tokens / (d / 1000));
  }
  return [...byModel.entries()].map(([model, m]) => {
    const ms = m.ms.sort((a, b) => a - b);
    const tps = m.tps.sort((a, b) => a - b);
    const tools = [...m.tools].sort();
    return {
      model, tools, approx: tools.some(t => APPROX_TOOLS.has(t)),
      requests: ms.length, speed_samples: tps.length,
      median_tps: round1(percentile(tps, 0.5)), p90_tps: round1(percentile(tps, 0.9)),
      median_ms: percentile(ms, 0.5), p90_ms: percentile(ms, 0.9),
    };
  }).sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
}
