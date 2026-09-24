import { isOffline } from './config.js';
import { computeRoi } from './roi.js';

/**
 * 社区排行榜（opt-in，默认关闭）。
 *
 * 信任边界：token-watcher 是本地优先工具，"往外发数据"必须是用户显式动作
 * （tokenwatcher leaderboard on <昵称>），且只发聚合数字。逐请求明细、
 * 文件路径、项目名、会话内容、API key、机器信息永不出本机。
 * 上报字段清单见 README 隐私说明，与 buildLeaderboardReport 逐一对应。
 *
 * 官方榜单实例部署在 cloud/（Cloudflare Worker + D1，可自托管），
 * 地址可用 tokenwatcher leaderboard url <https://…> 覆盖。
 */

// 官方实例。若 workers.dev 子域名不同，改这一处并重新发版即可（也可用上面的 url 子命令自托管）。
export const LEADERBOARD_URL_DEFAULT = 'https://token-watcher-leaderboard.ygnjd2016.workers.dev';

const SET = {
  ENABLED: 'leaderboard.enabled',
  NAME: 'leaderboard.name',
  URL: 'leaderboard.url',
  ID: 'leaderboard.id',
  LAST_PUSH: 'leaderboard.last_push_ms',
  LAST_OK: 'leaderboard.last_ok_ms',
  LAST_ERR: 'leaderboard.last_error',
};

/** 昵称黑名单：脏话 + 冒充官方。榜单只是虚荣数字，防线从简，社区可再补。 */
const BAD_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dick', 'nigg', 'spam',
  'admin', '官方', '管理员', '运营'];

/**
 * 昵称校验/清洗：1-16 个字符（按码点），去控制符与零宽字符，压缩空白；
 * 含链接 / @ / 黑名单词 → null（榜单是公开页面，昵称是唯一自由文本字段）。
 * cloud/lib.js 有逐行相同的副本（Worker 自包含部署），test/run.mjs 断言两侧一致。
 */
export function sanitizeName(raw) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  // 链接/导流：域名后缀或 www./http 前缀（大小写不敏感）
  if (/(https?:\/\/|www\.)|(\.(com|cn|net|org|io|dev|app|xyz|me|cc)\b)/i.test(s)) return null;
  if (s.includes('@')) return null;
  const low = s.toLowerCase();
  if (BAD_WORDS.some(w => low.includes(w))) return null;
  const cps = [...s];
  if (cps.length < 1 || cps.length > 16) return null;
  return s;
}

/** 数值封顶（服务端同样封，双保险）：负数归零、超限截断、占比 0-100、列表砍到 8 条 */
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

export function getLeaderboardState(store) {
  return {
    enabled: store.getSetting(SET.ENABLED) === true,
    name: store.getSetting(SET.NAME) || '',
    id: store.getSetting(SET.ID) || null,
    url: store.getSetting(SET.URL) || LEADERBOARD_URL_DEFAULT,
    last_push_ms: store.getSetting(SET.LAST_PUSH) || null,
    last_ok_ms: store.getSetting(SET.LAST_OK) || null,
    last_error: store.getSetting(SET.LAST_ERR) || null,
  };
}

/** 匿名 ID：本机一次性生成的随机 UUID，只作榜单去重锚点，不含任何机器指纹 */
export function ensureLeaderboardId(store) {
  let id = store.getSetting(SET.ID);
  if (!id) {
    id = crypto.randomUUID();
    store.setSetting(SET.ID, id);
  }
  return id;
}

/** 配置变更入口；昵称非法抛带人话的 Error，由 CLI 接住展示 */
export function setLeaderboardConfig(store, { enabled, name, url } = {}) {
  if (name !== undefined) {
    const okName = sanitizeName(name);
    if (!okName) throw new Error('昵称不可用：需 1-16 个字符，且不含链接、@、敏感词');
    store.setSetting(SET.NAME, okName);
  }
  if (url !== undefined) {
    const target = new URL(url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) ||
        target.username || target.password || target.search || target.hash) {
      throw new Error('榜单地址需使用 HTTPS，且不含凭据、查询或片段（本机测试可用 HTTP）');
    }
    store.setSetting(SET.URL, target.href.replace(/\/+$/, ''));
  }
  if (enabled === true) ensureLeaderboardId(store);
  if (enabled !== undefined) store.setSetting(SET.ENABLED, enabled === true);
}

/**
 * 聚合上报体：只含当天/近 7 天/近 30 天的总量、请求次数、模型与工具占比（百分比取整）、
 * 订阅 ROI 比值。roi_fn / now 可注入，测试不碰真实订阅文件与系统时钟。
 */
export async function buildLeaderboardReport(store, { now = Date.now(), roiFn = computeRoi } = {}) {
  const db = store.db;
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0); // 所有参与者采用同一个自然日
  const dayStart = d.getTime();
  const weekStart = now - 7 * 86_400_000;
  const monthStart = now - 30 * 86_400_000;

  const day = db.prepare('SELECT SUM(total_tokens) t, COUNT(*) n FROM events WHERE ts >= ? AND ts <= ?').get(dayStart, now);
  const week = db.prepare('SELECT SUM(total_tokens) t FROM events WHERE ts >= ? AND ts <= ?').get(weekStart, now);
  const month = db.prepare('SELECT SUM(total_tokens) t FROM events WHERE ts >= ? AND ts <= ?').get(monthStart, now);

  const modelRows = (start) => db.prepare(`
    SELECT model, SUM(total_tokens) t FROM events
    WHERE ts >= ? AND ts <= ? AND model IS NOT NULL AND model != ''
    GROUP BY model HAVING SUM(total_tokens) > 0 ORDER BY t DESC, model ASC LIMIT 5`).all(start, now);
  const byModel = modelRows(weekStart);
  const byTool = db.prepare(`
    SELECT tool, SUM(total_tokens) t FROM events
    WHERE ts >= ? AND ts <= ? GROUP BY tool ORDER BY t DESC LIMIT 5`).all(weekStart, now);

  const weekTotal = week.t || 0;
  const share = (rows, total = weekTotal) => rows.map(r => [r.model ?? r.tool, total > 0 ? Math.round((r.t / total) * 100) : 0]);

  let roi_ratio = null;
  try {
    const roi = await roiFn(db);
    if (roi?.configured) {
      let api = 0, paid = 0;
      for (const e of roi.entries || []) {
        if (e.paid_cny != null) { api += e.api_cny || 0; paid += e.paid_cny; }
      }
      // 只发比值不发金额：×N 不暴露任何人的绝对开销
      if (paid > 0 && api > 0) roi_ratio = Math.round((api / paid) * 10) / 10;
    }
  } catch { /* 订阅文件/牌价不可用：ROI 不上报，其余聚合照常 */ }

  const utcDay = d.toISOString().slice(0, 10);
  return {
    v: 1,
    day: utcDay,
    day_tokens: day.t || 0,
    day_requests: day.n || 0,
    week_tokens: weekTotal,
    month_tokens: month.t || 0,
    roi_ratio,
    models: share(byModel), // 保留周 Top5 字段，兼容旧 Worker。
    models_by_period: {
      day: share(modelRows(dayStart).slice(0, 1), day.t || 0),
      week: share(byModel.slice(0, 1)),
      month: share(modelRows(monthStart).slice(0, 1), month.t || 0),
    },
    tools: share(byTool),
  };
}

/** 上报一次（未开启/离线直接跳过；失败记录 last_error 供面板与 doctor 展示，不抛出） */
export async function pushLeaderboardReport(store, { log = () => {}, fetchImpl = fetch, now = Date.now(), timeoutMs = 10_000, roiFn } = {}) {
  const st = getLeaderboardState(store);
  if (!st.enabled) return { skipped: 'disabled' };
  if (!st.name) return { skipped: 'no-name' };
  if (isOffline()) return { skipped: 'offline' };
  let timer;
  try {
    const report = clampReport({ ...await buildLeaderboardReport(store, { now, roiFn }), id: st.id, name: st.name });
    // ROI 计算有异步步骤：途中退出或切换服务，不能继续向旧地址发送。
    const current = getLeaderboardState(store);
    if (!current.enabled || current.url !== st.url || current.name !== st.name || isOffline()) {
      return { skipped: 'config-changed' };
    }
    const ac = new AbortController();
    timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetchImpl(`${st.url}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    store.setSetting(SET.LAST_PUSH, now);
    store.setSetting(SET.LAST_OK, now);
    store.setSetting(SET.LAST_ERR, null);
    return { ok: true, report };
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 200);
    store.setSetting(SET.LAST_PUSH, now);
    store.setSetting(SET.LAST_ERR, msg);
    log(`leaderboard report failed: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取榜单（GET，含我方排名——id 只在已参与时才随查询发出） */
export async function fetchLeaderboard({ url, id = null, period = 'day', metric = 'tokens', fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const base = String(url ?? LEADERBOARD_URL_DEFAULT).replace(/\/+$/, '');
  const q = new URLSearchParams({
    period: ['week', 'month'].includes(period) ? period : 'day',
    metric: metric === 'roi' ? 'roi' : 'tokens',
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/leaderboard?${q}`, {
      signal: ac.signal, headers: id ? { 'X-Leaderboard-ID': id } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 常驻服务里的周期上报：每小时一次，启动 90 秒后先来一轮（首轮扫描刚好完成） */
export function scheduleLeaderboardUpload(store, { log = () => {}, intervalMs = 3600_000, fetchImpl = fetch } = {}) {
  const tick = () => pushLeaderboardReport(store, { log, fetchImpl }).catch(() => {});
  setTimeout(tick, 90_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
}
