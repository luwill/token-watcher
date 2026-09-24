/**
 * token-watcher 社区排行榜 Worker（Cloudflare Workers + D1）。
 * 部署与自托管见 cloud/README.md；隐私口径见仓库 README 的排行榜章节。
 *
 * 两个端点：
 *   POST /report（客户端每小时上报一次聚合数字，同 ID 60 秒内返回 429）
 *   GET  /leaderboard?period=day|week|month&metric=tokens|roi
 *   可选 X-Leaderboard-ID 请求头用于返回自己的排名，不把 ID 放入 URL。
 *
 * 防滥用从简（榜单只是虚荣数字）：昵称清洗 + 全字段封顶 + 60s 节流 +
 * 每日清除 30 天不活跃记录。不做账号体系，应用数据库不存 IP。
 */
import { sanitizeName, clampReport } from './lib.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*', // 榜单是公开数据；本地面板走本地代理，不依赖 CORS
  'cache-control': 'no-store', // 响应可能含个人排名，不能在共享缓存间复用
  'x-content-type-options': 'nosniff',
};

const THROTTLE_MS = 60_000;      // 同 ID 上报节流（正常节奏每小时一次）
const FRESH_MS = 24 * 3600_000;  // 近 7/30 天用量快照也必须在 24h 内刷新
const RETAIN_MS = 30 * 86400_000;     // 30 天不上报即删除（含 off 后的残留）
const TOP_ROWS = 50;
const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json400 = (msg) => new Response(JSON.stringify({ error: msg }), { status: 400, headers: JSON_HEADERS });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/healthz' && request.method === 'GET') {
        await env.DB.prepare('SELECT id FROM players LIMIT 1').first();
        return new Response('ok', { headers: { 'cache-control': 'no-store' } });
      }
      if (request.method === 'OPTIONS' && ['/report', '/leaderboard'].includes(url.pathname)) {
        return new Response(null, { status: 204, headers: { ...JSON_HEADERS,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type, X-Leaderboard-ID' } });
      }
      if ((url.pathname === '/report' && request.method === 'POST') ||
          (url.pathname === '/leaderboard' && request.method === 'GET')) {
        // Cloudflare 提供的来源 IP 仅用于边缘限流，不写入 D1，也不打印日志。
        // 限流按边缘位置执行，不是全局精确配额或防作弊机制。
        if (!env.RATE_LIMITER) return new Response('rate limiter unavailable', { status: 503 });
        const { success } = await env.RATE_LIMITER.limit({
          key: `${url.pathname}:${request.headers.get('CF-Connecting-IP') || 'local'}`,
        });
        if (!success) return tooMany();
        if (url.pathname === '/report') return await handleReport(request, env);
        return await handleBoard(request, url, env);
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: JSON_HEADERS });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'internal' }), { status: 500, headers: JSON_HEADERS });
    }
  },
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM players WHERE updated_at < ?').bind(Date.now() - RETAIN_MS).run();
  },
};

function tooMany() {
  return new Response(JSON.stringify({ error: 'rate limited' }), {
    status: 429, headers: { ...JSON_HEADERS, 'retry-after': '60' },
  });
}

async function handleReport(request, env) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return new Response('JSON required', { status: 415, headers: JSON_HEADERS });
  }
  // Content-Length 不可信；流式读取时同样封顶，避免 JSON 解析前的大包消耗。
  const reader = request.body?.getReader();
  if (!reader) return json400('bad json');
  let bytes = 0, raw = '';
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return new Response('report too large', { status: 413, headers: JSON_HEADERS });
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  let body;
  try { body = JSON.parse(raw); } catch { return json400('bad json'); }
  if (body?.v !== 1) return json400('bad version');
  if (typeof body?.id !== 'string' || !UUID.test(body.id)) return json400('bad id');
  const r = clampReport(body);
  const now = Date.now();
  if (r.day !== new Date(now).toISOString().slice(0, 10)) return json400('day must be current UTC date');
  const name = sanitizeName(body?.name) ?? `匿名-${r.id.slice(0, 4)}`;

  // 原子 upsert：被节流不能声称新数据已被接受。
  const result = await env.DB.prepare(`
    INSERT INTO players (id, name, day, day_tokens, day_requests, week_tokens, month_tokens, roi_ratio, models_json, models_by_period_json, tools_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, day = excluded.day, day_tokens = excluded.day_tokens,
      day_requests = excluded.day_requests, week_tokens = excluded.week_tokens,
      month_tokens = excluded.month_tokens,
      roi_ratio = excluded.roi_ratio, models_json = excluded.models_json,
      models_by_period_json = excluded.models_by_period_json,
      tools_json = excluded.tools_json, updated_at = excluded.updated_at
    WHERE players.updated_at + ${THROTTLE_MS} <= excluded.updated_at`)
    .bind(r.id, name, r.day, r.day_tokens, r.day_requests, r.week_tokens, r.month_tokens, r.roi_ratio,
      JSON.stringify(r.models), r.models_by_period ? JSON.stringify(r.models_by_period) : null,
      JSON.stringify(r.tools), now)
    .run();

  if (!result.meta.changes) return tooMany();
  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

/** 行→公开形态：绝不含 id（匿名 ID 只用于服务端定位"我"，不随榜单下发） */
function shape(row, rank, period) {
  let models = [], tools = [];
  try { models = JSON.parse(row.models_json || '[]'); } catch { /* 上报端已保证可解析 */ }
  try { tools = JSON.parse(row.tools_json || '[]'); } catch { /* 同上 */ }
  let periodModels = null;
  try { periodModels = JSON.parse(row.models_by_period_json || 'null'); } catch { /* 旧记录无周期模型 */ }
  const hasPeriod = Array.isArray(periodModels?.[period]);
  const modelsPeriod = hasPeriod || period === 'week' ? period : null;
  // 旧客户端只有周模型，不能把它当作今日或近 30 日主力。
  models = (hasPeriod ? periodModels[period] : period === 'week' ? models : []).slice(0, 1);
  return {
    rank,
    name: row.name,
    day_tokens: row.day_tokens,
    week_tokens: row.week_tokens,
    month_tokens: row.month_tokens ?? null,
    roi: row.roi_ratio,
    models, models_period: modelsPeriod, tools,
    updated_at: row.updated_at,
  };
}

async function handleBoard(request, url, env) {
  const requestedPeriod = url.searchParams.get('period');
  const period = ['week', 'month'].includes(requestedPeriod) ? requestedPeriod : 'day';
  const metric = url.searchParams.get('metric') === 'roi' ? 'roi' : 'tokens';
  const me = request.headers.get('X-Leaderboard-ID') || '';
  if (me && !UUID.test(me)) return json400('bad id');
  const now = Date.now();
  const fresh = now - FRESH_MS;
  const day = new Date(now).toISOString().slice(0, 10);
  const metricCol = metric === 'roi' ? 'roi_ratio' : ({ day: 'day_tokens', week: 'week_tokens', month: 'month_tokens' }[period]);
  // 对全体有效参与者排名后才取前 50，自己的排名不受展示条数限制。
  // 相同用量以稳定 ID 排序；该 ID 始终不进入公开响应。
  const { results } = await env.DB.prepare(`
    WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY ${metricCol} DESC, id ASC) position,
        COUNT(*) OVER () player_count
      FROM players WHERE updated_at > ? AND (? != 'day' OR day = ?)
        AND ${metricCol} IS NOT NULL AND ${metricCol} > 0
    )
    SELECT * FROM ranked WHERE position <= ? OR id = ? ORDER BY position`)
    .bind(fresh, period, day, TOP_ROWS, me)
    .all();
  const rows = results.filter(row => row.position <= TOP_ROWS).map(row => shape(row, row.position, period));
  const own = me ? results.find(row => row.id === me) : null;
  return new Response(JSON.stringify({
    period, metric, day, timezone: 'UTC',
    players: results[0]?.player_count ?? 0,
    updated_at: now,
    rows,
    me: own ? shape(own, own.position, period) : null,
    me_rank: own?.position ?? null,
  }), { headers: JSON_HEADERS });
}
