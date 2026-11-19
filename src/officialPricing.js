/** 官方 Standard/产品刊例价，2026-10-14 核对；单位：每百万 token。 */
export const PRICE_SOURCES = {
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  cursor: 'https://cursor.com/docs/models-and-pricing',
  xai: 'https://docs.x.ai/developers/pricing',
  kimi: 'https://platform.kimi.com/docs/pricing/chat',
  step: 'https://platform.stepfun.com/docs/zh/guides/pricing/details',
  qwen: 'https://help.aliyun.com/zh/model-studio/model-pricing', // 2026-11-19 核对
  tencent: 'https://cloud.tencent.com/act/pro/tokenplan',
  opencode: 'https://opencode.ai/v2/docs/console/models/',
  openrouter: 'https://openrouter.ai/api/v1/models',
  union: 'https://openrouter.ai/stealth/union-alpha',
};

/** 同价别名只按已验证的来源解析；不修改历史模型名、去重键或用户配置。 */
export function pricingModel(model, tool) {
  if (tool === 'antigravity' && model === 'gemini-3.8-flash-n') return 'gemini-3.8-flash';
  if (tool === 'kimi' && model === 'k3') return 'kimi-k3';
  if (tool === 'workbuddy' && model === 'kimi-k3-1') return 'kimi-k3'; // 官方配置名 Kimi-K3，不是 K3.1
  if (tool === 'workbuddy' && model === 'hy4-preview-f') return 'hy4-preview'; // targetModelId=hy4-preview
  if (tool === 'grok' && /^grok-4\.[67]-build$/.test(model)) return model.replace(/-build$/, '');
  return model;
}

const usd = (input, cached, output, source, write = 0) => ({
  currency: 'USD', input_miss: input, input_hit: cached, output, input_write: write, source,
});
const cny = (input, cached, output, source, write = 0) => ({
  currency: 'CNY', input_miss: input, input_hit: cached, output, input_write: write, source,
});

export function officialPrice(model, { tool, now = Date.now(), longContext = false } = {}) {
  const id = pricingModel(model, tool);
  if (id === 'gemini-4-argon') {
    return now < Date.UTC(2026, 11, 1) ? usd(2, 0.10, 10, PRICE_SOURCES.google)
      : usd(4, 0.20, 20, PRICE_SOURCES.google);
  }
  if (id === 'gemini-3.8-flash') {
    return now < Date.UTC(2027, 0, 1) ? usd(0.75, 0.075, 3.75, PRICE_SOURCES.google)
      : usd(1.50, 0.15, 7.50, PRICE_SOURCES.google);
  }
  if (id === 'claude-opus-5-5') return usd(4, 0.20, 20, PRICE_SOURCES.anthropic, 5);
  // Cursor MAX 是 API+20%，不是 Anthropic fast mode。
  if (tool === 'cursor' && id === 'claude-opus-5-5-max') return usd(4.8, 0.24, 24, PRICE_SOURCES.cursor, 6);
  if (id === 'grok-4.7' || id === 'grok-4.6') {
    return longContext ? usd(4, 1, 12, PRICE_SOURCES.xai) : usd(2, 0.5, 6, PRICE_SOURCES.xai);
  }
  if (id === 'grok-4.5') return longContext ? usd(4, 0.6, 12, PRICE_SOURCES.xai) : usd(2, 0.3, 6, PRICE_SOURCES.xai);
  if ((tool === 'cursor' || tool === 'grok') && (id === 'grok-4.7-high-fast' || id === 'grok-4.7-fast')) {
    return longContext ? usd(6, 1.5, 18, PRICE_SOURCES.xai) : usd(4, 1, 12, PRICE_SOURCES.xai);
  }
  if (id === 'kimi-k3') return cny(20, 2, 100, PRICE_SOURCES.kimi, 20); // 默认 5min cache write
  // 百炼华北2：0–1M 输入单档，思考/非思考同价；缓存命中 0.5、5min 显式缓存写 12.5。
  // 只认正式 ID：preview / 邀测 ID 未见官方同价说明，不臆测归并。
  if (id === 'qwen4-max') return cny(10, 0.5, 30, PRICE_SOURCES.qwen, 12.5);
  if (id === 'hy4-preview') return cny(6, 0.3, 18, PRICE_SOURCES.tencent);
  if (id === 'step-5-preview') {
    // 旧账户 0.35 的资格不可从 token 推断，使用现行公开 0.70，资格价可手动覆盖。
    return cny(7, now < Date.UTC(2026, 9, 13, 16, 30) ? 0.35 : 0.70, 20, PRICE_SOURCES.step);
  }
  if (tool === 'opencode' && id === 'mimo-v2.5-free') return usd(0, 0, 0, PRICE_SOURCES.opencode);
  // 该已退役的免费 stealth ID 保留原免费口径，不套用新 Pareto 付费模型价格。
  if (tool === 'opencode' && id === 'stealth/union-alpha') return usd(0, 0, 0, PRICE_SOURCES.union);
  // 完整 OpenRouter ID 的实时目录参考价；不套用 DeepSeek 直连的峰谷价。
  if (id === 'deepseek/deepseek-v4-flash-0731') return usd(0.016, 0.016, 0.64, PRICE_SOURCES.openrouter);
  return null;
}

/** Cursor CSV / Grok turn 是多次调用合计，不能据此还原每次请求的 200k 档位。 */
export const LONG_CONTEXT_SQL = `(CASE WHEN tool IN ('cursor', 'grok') THEN 0
  ELSE CASE WHEN input_tokens + cached_input + cache_write >= 200000 THEN 1 ELSE 0 END END)`;
