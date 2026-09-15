import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { WEB_DIR, ECHARTS_PATH, DB_PATH, isOffline } from './config.js';
import { learnWorkbuddyRates } from './rates.js';
import { loadPricing, computeCosts, computeRecon } from './pricing.js';
import { ensurePrices, setOnChange as onPricesLoaded } from './litellm.js';
import { ensureFxRate, setOnChange as onFxLoaded } from './fx.js';

const DB_DIRPATH = dirname(DB_PATH);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** 连续使用天数：从今天（或昨天）往前数有用量的连续自然日 */
function computeStreak(daySet, todayKey, yesterdayKey) {
  let streak = 0;
  let cursor = daySet.has(todayKey) ? todayKey : yesterdayKey;
  if (!daySet.has(cursor)) return 0;
  const d = new Date();
  const [y, m, day] = cursor.split('-').map(Number);
  d.setFullYear(y, m - 1, day);
  while (daySet.has(cursor)) {
    streak++;
    d.setDate(d.getDate() - 1);
    const p = d.getMonth() + 1, q = d.getDate();
    cursor = `${d.getFullYear()}-${String(p).padStart(2, '0')}-${String(q).padStart(2, '0')}`;
  }
  return streak;
}

/**
 * Claude 订阅 5h 窗口推算（ccusage session-blocks 法）：
 * 会话内事件按 5h 滚动窗分块（块内首事件为块起点），当前窗口 = 与 now 重叠的所有块用量之和。
 * 只算订阅制的 claude-code；ccmr 走 API 计费，无窗口概念。
 */
function computeClaude5h(db, now = Date.now()) {
  const rows = db.prepare(`
    SELECT session_id, ts, total_tokens FROM events
    WHERE tool = 'claude-code' AND ts >= ? ORDER BY session_id, ts`).all(now - 36 * 3_600_000);
  const H5 = 5 * 3_600_000;
  let blockStart = null, curSession = null;
  let tokens = 0, calls = 0, start = null;
  for (const r of rows) {
    if (r.session_id !== curSession || r.ts - blockStart >= H5) {
      curSession = r.session_id;
      blockStart = r.ts;
    }
    if (blockStart <= now && now < blockStart + H5) {
      if (start === null || blockStart < start) start = blockStart;
      tokens += r.total_tokens;
      calls++;
    }
  }
  return start === null
    ? { active: false, window_tokens: tokens, window_calls: calls, window_start: null, window_ends_at: null }
    : { active: true, window_tokens: tokens, window_calls: calls, window_start: start, window_ends_at: start + H5 };
}

/**
 * 数据源健康自检：
 * - error：本轮扫描有解析错误（格式漂移的最直接信号）
 * - stale：数据文件最近 30 分钟内在写入，但 30 分钟内没有解析出新事件（静默失败信号）
 * - empty：从未采集到事件
 * - ok：其余（含"只是没在用"——不误报）
 */
function computeHealth(db, scannerStats) {
  const tools = ['claude-code', 'ccmr', 'codex', 'zcode', 'dsh', 'workbuddy', 'grok'];
  const now = Date.now();
  return tools.map(tool => {
    const ev = db.prepare(
      'SELECT COUNT(*) n, MAX(ts) last_ts FROM events WHERE tool = ?').get(tool);
    const f = db.prepare(
      'SELECT COUNT(*) n, MAX(mtime_ms) max_mtime FROM files WHERE tool = ?').get(tool);
    const st = scannerStats[tool] || {};
    let status = 'ok';
    if (!ev.n) status = 'empty';
    else if ((st.parse_errors || 0) > 0) status = 'error';
    else if (f.max_mtime && ev.last_ts &&
             f.max_mtime > now - 30 * 60_000 &&
             f.max_mtime - ev.last_ts > 30 * 60_000) status = 'stale';
    return {
      tool, status,
      events: ev.n,
      last_event_ts: ev.last_ts,
      files: f.n,
      last_file_mtime: f.max_mtime,
      parse_errors: st.parse_errors || 0,
      last_error: st.last_error || null,
      last_scan_ms: st.last_scan_ms || null,
    };
  });
}

export async function buildSummary(store, scannerStats, days, { balanceStatus = [] } = {}) {
  const db = store.db;
  const now = Date.now();
  const todayStart = startOfDay();
  const yStart = todayStart - 86_400_000;
  const localKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const todayK = localKey(todayStart);
  const yesterdayK = localKey(yStart);

  // 按自然日对齐：近 N 天 = 今天 0 点往前 N-1 天，避免 21 点查 7 天返回 8 个日桶
  const rangeStart = days > 0 ? todayStart - (days - 1) * 86_400_000 : 0;

  const allTime = db.prepare('SELECT COUNT(*) n, SUM(total_tokens) total FROM events').get();
  const today = db.prepare('SELECT SUM(total_tokens) total FROM events WHERE ts >= ?').get(todayStart);
  const last7 = db.prepare('SELECT SUM(total_tokens) total FROM events WHERE ts >= ?').get(now - 7 * 86_400_000);
  const peak = db.prepare(`
    SELECT MAX(total) peak FROM (
      SELECT SUM(total_tokens) total FROM events
      GROUP BY date(ts/1000, 'unixepoch', 'localtime'))`).get();
  const todaySessions = db.prepare(
    'SELECT COUNT(DISTINCT session_id) n FROM events WHERE ts >= ?').get(todayStart);

  const dayRows = db.prepare(`
    SELECT date(ts/1000, 'unixepoch', 'localtime') d, tool, SUM(total_tokens) total
    FROM events WHERE ts >= ? GROUP BY d, tool ORDER BY d`).all(rangeStart);
  const dayAllRows = db.prepare(`
    SELECT date(ts/1000, 'unixepoch', 'localtime') d, SUM(total_tokens) total
    FROM events GROUP BY d ORDER BY d`).all();
  const modelRows = db.prepare(`
    SELECT model, SUM(total_tokens) total, COUNT(*) n FROM events
    WHERE ts >= ? GROUP BY model ORDER BY total DESC LIMIT 10`).all(rangeStart);
  const toolRows = db.prepare(`
    SELECT tool, SUM(total_tokens) total, COUNT(*) n FROM events
    WHERE ts >= ? GROUP BY tool ORDER BY total DESC`).all(rangeStart);
  const recent = db.prepare(`
    SELECT ts, tool, model, project, input_tokens, cached_input, output_tokens, total_tokens
    FROM events ORDER BY ts DESC, id DESC LIMIT 15`).all();

  const daySet = new Set(db.prepare(
    `SELECT DISTINCT date(ts/1000, 'unixepoch', 'localtime') d FROM events`).all().map(r => r.d));

  // byDay → [{day, tools: {tool: total}, total}]
  const byDayMap = new Map();
  for (const r of dayRows) {
    if (!byDayMap.has(r.d)) byDayMap.set(r.d, { day: r.d, tools: {}, total: 0 });
    const e = byDayMap.get(r.d);
    e.tools[r.tool] = (e.tools[r.tool] || 0) + r.total;
    e.total += r.total;
  }

  // 先算费用：对账要复用同一份汇率，两张卡才不会各说各话
  const costs = await computeCosts(db, days);

  return {
    generated_at: now,
    range_days: days,
    offline: isOffline(),
    totals: {
      all_time_tokens: allTime.total || 0,
      all_time_events: allTime.n || 0,
      today_tokens: today.total || 0,
      last7d_tokens: last7.total || 0,
      peak_day_tokens: peak.peak || 0,
      today_active_sessions: todaySessions.n || 0,
      streak_days: computeStreak(daySet, todayK, yesterdayK),
      active_days: daySet.size,
    },
    by_day: [...byDayMap.values()],
    by_day_all: dayAllRows,
    by_model: modelRows,
    by_tool: toolRows,
    quota: { codex: store.getQuota('codex'), claude5h: computeClaude5h(db) },
    balances: store.getBalances(),
    wb_rates: store.getRates(),
    health: computeHealth(db, scannerStats || {}),
    balance_status: balanceStatus,
    live: { grok: (() => {
      const q = store.getQuota('grok:live');
      if (!q || Date.now() - q.ts > 10 * 60_000) return null; // 10 分钟无写入视为已结束
      return { ...q.data, ts: q.ts };
    })() },
    costs,
    recon: computeRecon(db, store, await loadPricing(), { rate: costs.usd_to_cny }),
    recent,
  };
}

async function serveFile(res, path, type) {
  const s = await stat(path).catch(() => null);
  if (!s || !s.isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, {
    'content-type': type || MIME[extname(path)] || 'application/octet-stream',
    'content-length': s.size,
    'cache-control': 'no-cache',
  });
  createReadStream(path).pipe(res);
}

function db_safe(store) { return store.db; }

/** Host 头是否指向本机（端口无关）；缺失 Host 的裸 HTTP/1.0 请求按本机放行 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '']);
function isLocalHost(host) {
  const h = String(host ?? '').toLowerCase().trim();
  // IPv6 字面量形如 [::1]:8787；IPv4/域名形如 127.0.0.1:8787
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(name);
}

/**
 * 路由统一错误处理。
 * createServer 的 handler 是 async：任何冒泡出去的异常都是未处理 rejection，
 * Node 默认直接退出进程——一次 SQLITE_BUSY 就能让常驻面板整个消失。
 * 错误详情只进本地日志（可能含本地路径），响应体只给一句通用说明。
 */
export function withErrors(handler, log = () => {}) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      log(`request failed ${req?.url ?? '?'}: ${err?.message ?? err}`);
      if (res.headersSent) res.end();
      else json(res, 500, { error: 'request failed, see server log' });
    }
  };
}

/** 每日备份（VACUUM INTO 快照，保留最近 7 份） */
function scheduleBackup(store, log = () => {}) {
  const run = () => {
    const dir = join(DB_DIRPATH, 'backups');
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      const target = join(dir, `token-watcher-${stamp}.db`);
      try {
        store.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      } catch (e) {
        if (!/already exists|已存在/i.test(e.message)) throw e;
      }
      // 只留最近 7 份
      const files = readdirSync(dir).filter(f => f.endsWith('.db')).sort();
      for (const f of files.slice(0, -7)) rmSync(join(dir, f));
      log(`backup ok: ${stamp}`);
    } catch (e) { log(`backup failed: ${e.message}`); }
  };
  setTimeout(run, 30_000).unref?.();
  setInterval(run, 24 * 3600_000).unref?.();
}

export function startServer({ store, scanner, balancePoller, port, log = () => {} }) {
  const clients = new Set();
  const notify = () => { for (const res of clients) res.write(`data: {"type":"update"}\n\n`); };
  scanner.on('update', notify);
  // 新事件可能带来新的 credit 轮次 → 重跑费率自学习再通知前端
  scanner.on('update', () => {
    try { learnWorkbuddyRates(store); } catch (e) { log(`rates: ${e.message}`); }
  });
  if (balancePoller) {
    balancePoller.onChange = notify;
    balancePoller.start();
  }
  scheduleBackup(store, log);
  onPricesLoaded(notify);                          // 价格加载/刷新后推送前端
  onFxLoaded(notify);                              // 汇率加载/刷新后推送前端
  ensurePrices().catch(() => {});
  ensureFxRate({}).catch(() => {});
  // 离线模式没有可刷新的远端来源，不排这个定时任务
  if (isOffline()) log('离线模式：跳过汇率 / LiteLLM 牌价 / 余额的全部外网请求');
  else setInterval(() => ensurePrices({ force: true }).catch(() => {}), 24 * 3600_000).unref?.();
  try { learnWorkbuddyRates(store); } catch { /* 首次静默 */ }

  const server = createServer(withErrors(async (req, res) => {
    // DNS rebinding 防护：只绑 127.0.0.1 挡不住恶意页面把自家域名解析到本机再来读面板。
    // 浏览器会如实带上它请求的主机名，本机访问只会是 127.0.0.1 / localhost / ::1。
    if (!isLocalHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('forbidden host');
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/summary') {
      const days = Math.max(0, Math.min(3650, Number(url.searchParams.get('days')) || 30));
      try {
        return json(res, 200, await buildSummary(store, scanner.stats, days, {
          balanceStatus: balancePoller?.status?.() ?? [],
        }));
      } catch (err) {
        log(`summary error: ${err.message}`); // 详情仅进本地日志；错误消息可能含本地路径，不外发
        return json(res, 500, { error: 'summary failed, see server log' });
      }
    }
    if (p === '/api/sessions') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '')
        ? url.searchParams.get('day')
        : new Date().toLocaleDateString('sv-SE'); // 本地今天 YYYY-MM-DD
      const tool = url.searchParams.get('tool') || '';
      const rows = db_safe(store).prepare(`
        SELECT session_id, tool, MIN(ts) first_ts, MAX(ts) last_ts, COUNT(*) calls,
               SUM(total_tokens) total, MAX(total_tokens) peak, MAX(project) project,
               GROUP_CONCAT(DISTINCT model) models
        FROM events WHERE date(ts/1000, 'unixepoch', 'localtime') = ? ${tool ? 'AND tool = ?' : ''}
        GROUP BY session_id ORDER BY total DESC LIMIT 60`)
        .all(...(tool ? [day, tool] : [day]));
      return json(res, 200, { day, sessions: rows });
    }
    if (p.startsWith('/api/session/')) {
      const sid = decodeURIComponent(p.slice('/api/session/'.length));
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(sid)) return json(res, 400, { error: 'bad id' });
      const rows = db_safe(store).prepare(`
        SELECT ts, model, input_tokens, cached_input, cache_write, output_tokens, total_tokens
        FROM events WHERE session_id = ? ORDER BY ts LIMIT 5000`).all(sid);
      return json(res, 200, { session_id: sid, events: rows });
    }
    if (p === '/api/tool-activity') {
      const days = Math.max(1, Math.min(3650, Number(url.searchParams.get('days')) || 30));
      const since = Date.now() - days * 86_400_000;
      const rows = db_safe(store).prepare(`
        SELECT name, tool, COUNT(*) n FROM tool_calls WHERE ts >= ?
        GROUP BY name, tool ORDER BY n DESC LIMIT 60`).all(since);
      const merged = new Map();
      for (const r of rows) {
        if (!merged.has(r.name)) merged.set(r.name, { name: r.name, n: 0, tools: {} });
        const m = merged.get(r.name);
        m.n += r.n;
        m.tools[r.tool] = (m.tools[r.tool] || 0) + r.n;
      }
      return json(res, 200, { days, tools: [...merged.values()].sort((a, b) => b.n - a.n).slice(0, 14) });
    }
    if (p === '/api/export.csv') {
      const days = Math.max(0, Math.min(3650, Number(url.searchParams.get('days')) || 30));
      const since = days > 0 ? startOfDay() - (days - 1) * 86_400_000 : 0;
      const rows = db_safe(store).prepare(`
        SELECT date(ts/1000, 'unixepoch', 'localtime') d, tool,
               SUM(input_tokens) input, SUM(cached_input) cached, SUM(cache_write) cache_write,
               SUM(output_tokens) output, SUM(total_tokens) total, COUNT(*) calls
        FROM events WHERE ts >= ? GROUP BY d, tool ORDER BY d`).all(since);
      const esc = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
      const csv = 'day,tool,input,cached_input,cache_write,output,total,calls\n' +
        rows.map(r => [r.d, r.tool, r.input, r.cached, r.cache_write, r.output, r.total, r.calls].map(esc).join(',')).join('\n') + '\n';
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="token-watcher-${days || 'all'}d.csv"`,
      });
      return res.end(csv);
    }
    if (p === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (p === '/vendor/echarts.min.js') return serveFile(res, ECHARTS_PATH, MIME['.js']);
    if (p === '/') return serveFile(res, join(WEB_DIR, 'index.html'));
    // 静态资源：限制在 web 目录内
    const safe = resolve(WEB_DIR, '.' + p);
    if (safe.startsWith(resolve(WEB_DIR))) return serveFile(res, safe);
    res.writeHead(404); res.end();
  }, log));

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      log(`listening on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}
