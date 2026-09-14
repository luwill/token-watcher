/**
 * 模型名归一化：跨源合并同一模型的大小写变体
 * （ZCode 记 GLM-5.3-Flash、WorkBuddy 记 glm-5.3-flash → 统一小写）。
 * 同时与 rates / pricing 的键（全小写）对齐。
 */
export function normalizeModel(m) {
  if (typeof m !== 'string') return m;
  const n = m.trim().toLowerCase();
  return n || null;
}
