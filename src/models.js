/**
 * 模型名归一化：跨源合并同一模型的大小写变体
 * （ZCode 记 GLM-5.3-Flash、WorkBuddy 记 glm-5.3-flash → 统一小写）。
 * 同时与 rates / pricing 的键（全小写）对齐。
 */
// 同一模型的不同 id（路由事实，来源 ccmr models.yaml / 厂商公告）
const ALIASES = {
  'deepseek-flash': 'deepseek-v4.1-flash',     // V4.1 Flash 沿用旧 id
  'deepseek-v4-flash': 'deepseek-v4.1-flash',  // V4 Flash 线已下线，请求路由至 V4.1 Flash
};

export function normalizeModel(m) {
  if (typeof m !== 'string') return m;
  const n = m.trim().toLowerCase();
  if (!n) return null;
  return ALIASES[n] ?? n;
}
