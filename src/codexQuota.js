/**
 * Codex 账号配额快照（token_count 事件里的 rate_limits）。
 *
 * primary / secondary 是**位置**，不是含义——只能按 window_minutes 认窗口：
 *   plus：primary = 300 分钟（5 小时），secondary = 10080 分钟（周）
 *   pro / prolite：只有 primary = 10080（周）；同一套餐也在两种形态间切换过
 * 同一条事件流里还混着非主额度的快照：Spark 模型的独立额度（limit_id=codex_bengalfox）、
 * 窗口全空的 premium。它们一旦成为"最新一条"就会顶掉主额度，必须在入库前过滤。
 */
const MAIN_LIMIT_ID = 'codex';

const toWindow = (w) => ({
  window_minutes: w.window_minutes,
  used_percent: w.used_percent ?? null,
  resets_at: w.resets_at ?? null,
});

/** rate_limits → 入库的配额快照；不是主额度或没有任何窗口时返回 null（不入库） */
export function quotaFromRateLimits(rl) {
  if (!rl) return null;
  // 旧版快照没有 limit_id，那时只有主额度
  if (rl.limit_id != null && rl.limit_id !== MAIN_LIMIT_ID) return null;
  const windows = [rl.primary, rl.secondary]
    .filter(w => w && Number(w.window_minutes) > 0)
    .map(toWindow)
    .sort((a, b) => a.window_minutes - b.window_minutes);
  if (!windows.length) return null;
  return { plan_type: rl.plan_type ?? null, windows };
}

/**
 * 供 API 输出的视图。升级前存下的是旧形态（只取了 primary 的平铺字段），
 * 快照是单条"最新值"、下一次 Codex 调用就会覆盖，不值得为它全量重扫 2GB+ 的 rollout；
 * 这里就地转成窗口列表，旧值里的 window_minutes 足以给出正确标签。
 */
export function codexQuotaView(row) {
  if (!row?.data) return null;
  const d = row.data;
  if (Array.isArray(d.windows)) return row;
  const windows = Number(d.window_minutes) > 0 ? [toWindow(d)] : [];
  return { ...row, data: { plan_type: d.plan_type ?? null, windows } };
}
