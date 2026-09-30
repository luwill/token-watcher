/**
 * 榜单 Worker 的输入校验。
 * 与 src/leaderboard.js 中的 sanitizeName / clampReport 逐行相同：
 * npm 包不含 cloud/，Worker 部署不依赖 src/，两侧各持一份，
 * test/run.mjs 用同一组用例断言两者行为一致（漂移即漏防/误杀）。
 */

/** 昵称黑名单：脏话 + 冒充官方。榜单只是虚荣数字，防线从简，社区可再补。 */
const BAD_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dick', 'nigg', 'spam',
  'admin', '官方', '管理员', '运营'];

/** 昵称校验/清洗：1-16 个字符（按码点），非法返回 null */
export function sanitizeName(raw) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (/(https?:\/\/|www\.)|(\.(com|cn|net|org|io|dev|app|xyz|me|cc)\b)/i.test(s)) return null;
  if (s.includes('@')) return null;
  const low = s.toLowerCase();
  if (BAD_WORDS.some(w => low.includes(w))) return null;
  const cps = [...s];
  if (cps.length < 1 || cps.length > 16) return null;
  return s;
}

/** 服务端二次封顶：客户端会先钳一遍，但服务端不能信任任何客户端 */
export function clampReport(r) {
  const int = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const shares = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 8)
    .filter(p => Array.isArray(p) && typeof p[0] === 'string' && p[0])
    .map(([m, v]) => [m.slice(0, 60), Math.max(0, Math.min(100, Math.round(Number(v) || 0)))]);
  const periodModels = Object.fromEntries(['day', 'week', 'month']
    .filter(period => Array.isArray(r?.models_by_period?.[period]))
    .map(period => [period, shares(r.models_by_period[period]).slice(0, 1)]));
  const roi = r?.roi_ratio == null ? NaN : Number(r.roi_ratio); // null 是"未配置"，不能被 Number(null)=0 钳成 ×0
  return {
    v: 1,
    id: String(r?.id ?? '').slice(0, 64),
    name: String(r?.name ?? '').slice(0, 32),
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(r?.day)) ? String(r.day) : null,
    day_tokens: int(r?.day_tokens, 1e12),
    day_requests: int(r?.day_requests, 1e7),
    week_tokens: int(r?.week_tokens, 1e13),
    // 旧客户端缺失该字段表示未知，不能把周用量当作月用量。
    month_tokens: typeof r?.month_tokens === 'number' && Number.isFinite(r.month_tokens)
      ? int(r.month_tokens, 5e13) : null,
    roi_ratio: Number.isFinite(roi) ? Math.max(0, Math.min(1e4, Math.round(roi * 10) / 10)) : null,
    models: shares(r?.models),
    models_by_period: Object.keys(periodModels).length ? periodModels : null,
    tools: shares(r?.tools),
  };
}

/**
 * 合理性上限。依据 2026-09 的真实重度用户（单日 11.2 亿 token / 6355 次请求 / 单小时 3.5 亿，
 * 按天平均每次请求最多 66.8 万）各放宽 7~30 倍：宁可放过夸张的真数据，也不误伤真人。
 */
export const PLAUSIBLE = {
  DAY_TOKENS: 2e10,          // 200 亿 / 天
  HOUR_TOKENS: 5e9,          // 从 UTC 零点起每小时最多新增 50 亿
  DAY_REQUESTS: 2e5,
  TOKENS_PER_REQUEST: 5e6,   // 当日平均每次请求
};

/**
 * 服务端合理性检查，针对原始上报（截断之前）：超限、自相矛盾、增长快于可能，一律拒收。
 * 不截断到上限——截断会把造假者恰好送上第一名。返回拒收原因，合理返回 null。
 * 这不能证明数据是真的（数据来自用户本机，代码开源），只能挡住离谱与自相矛盾的上报。
 */
export function implausibleReason(body, now = Date.now()) {
  const num = (v, required = true) => {
    if (v == null) return required ? NaN : null;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : NaN;
  };
  const day = num(body?.day_tokens), req = num(body?.day_requests);
  const week = num(body?.week_tokens), month = num(body?.month_tokens, false); // 旧客户端无 30 日字段
  if ([day, req, week, month].some(Number.isNaN)) return 'usage must be non-negative numbers';
  if (day > PLAUSIBLE.DAY_TOKENS) return 'day_tokens implausible';
  const d = new Date(now);
  const hoursToday = (now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 3600_000;
  if (day > PLAUSIBLE.HOUR_TOKENS * (hoursToday + 1)) return 'day_tokens grew too fast';
  if (req > PLAUSIBLE.DAY_REQUESTS) return 'day_requests implausible';
  if (day > 0 && req < 1) return 'usage without requests';
  if (req > 0 && day / req > PLAUSIBLE.TOKENS_PER_REQUEST) return 'tokens per request implausible';
  // 客户端同一时刻算三个窗口：UTC 今天 ⊆ 滚动 7 天 ⊆ 滚动 30 天
  if (week < day || (month != null && month < week)) return 'windows inconsistent';
  if (week > 7 * PLAUSIBLE.DAY_TOKENS || (month != null && month > 30 * PLAUSIBLE.DAY_TOKENS)) return 'window totals implausible';
  return null;
}
