import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { buildSummary } from '../src/server.js';
import { aggregateCosts, loadPricing } from '../src/pricing.js';

const H = 3_600_000, D = 24 * H;
const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime(); // 本地 2026-10-20 15:00
const days = (n) => NOW - n * D;

/** summary 里依赖全历史聚合的部分；其余字段（配额、余额、实时状态）与缓存无关 */
function project(s) {
  const round = (v) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v);
  const costs = JSON.parse(JSON.stringify(s.costs, (k, v) => round(v)));
  delete costs.fx_ts;
  return {
    totals: s.totals, by_day: s.by_day, by_day_all: s.by_day_all, by_model: s.by_model, by_tool: s.by_tool,
    health: s.health.map(({ last_scan_ms, ...h }) => h), costs,
  };
}

/**
 * 历史聚合缓存（src/historyCache.js，issue #13）：命中缓存的结果必须与冷算逐项一致，
 * 任何改动历史行的路径都要让缓存失效；只写今天的行不应触发重算。
 */
export async function testHistoryCache(ok) {
  console.log('\n[summary] history aggregate cache: warm == cold, invalidation paths');
  const root = mkdtempSync(join(tmpdir(), 'tw-history-'));
  const file = join(root, 'tm.db');
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); } catch (err) { ok(name, false, err.stack); }
  };
  const store = new Store(file);
  let seq = 0;
  const ev = (s, ts, patch = {}) => s.insertEvent({
    ts, tool: 'dsh', model: 'deepseek-v4-pro', session_id: `s${seq % 5}`, project: 'p',
    input_tokens: 1000, cached_input: 500, cache_write: 0, output_tokens: 200, total_tokens: 1700,
    dedup_key: `hc:${seq++}`, ...patch,
  });
  // 历史行：40 天跨度，峰谷时段（UTC 02 点为峰）、长上下文、无牌价模型、空模型、空会话
  for (let i = 1; i <= 40; i++) {
    ev(store, days(i));
    ev(store, days(i) + 7 * H, { model: 'mystery-model' });
    ev(store, days(i) + 2 * H, { tool: 'codex', model: 'gpt-5.5', input_tokens: 250_000, total_tokens: 250_200 });
    if (i % 7 === 0) ev(store, days(i) + 3 * H, { model: null, session_id: null });
  }
  ev(store, NOW - H); ev(store, NOW - 2 * H, { tool: 'codex', model: 'gpt-5.5' });

  // 统计历史段重算次数：historyCache 的 compute 调用带有限的上界参数
  let historyQueries = 0;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    const st = prepare(sql);
    if (/ts >= \? AND ts < \?/.test(sql)) {
      const all = st.all.bind(st);
      st.all = (...a) => { if (a.at(-1) !== undefined && a.at(-1) < Number.MAX_SAFE_INTEGER) historyQueries++; return all(...a); };
    }
    return st;
  };
  const summary = (s, now = NOW) => buildSummary(s, {}, 30, { now });
  const cold = async (now = NOW) => {
    const fresh = new Store(file);
    try { return project(await summary(fresh, now)); } finally { fresh.close(); }
  };
  const same = async (label, now = NOW) => assert.deepEqual(project(await summary(store, now)), await cold(now), label);

  try {
    await check('first call matches a direct full-history aggregation', async () => {
      const s = await summary(store);
      const pricing = await loadPricing();
      const ref = aggregateCosts(store.db, 0, { rate: s.costs.usd_to_cny, table: pricing.models || {}, now: NOW });
      const r = (v) => Math.round(v * 1e9) / 1e9;
      assert.equal(r(s.costs.all_cny), r(ref.cny));
      assert.deepEqual(s.costs.by_model.map(m => [m.model, r(m.cost_cny), m.tokens]), ref.by_model.map(m => [m.model, r(m.cost_cny), m.tokens]));
      assert.deepEqual(s.costs.unpriced, ref.unpriced);
      const all = store.db.prepare(`SELECT date(ts/1000, 'unixepoch', 'localtime') d, SUM(total_tokens) total
        FROM events GROUP BY d ORDER BY d`).all().map(x => ({ d: x.d, total: x.total }));
      assert.deepEqual(s.by_day_all, all);
      assert.equal(s.totals.all_time_events, store.db.prepare('SELECT COUNT(*) n FROM events').get().n);
      const todayStart = new Date(2026, 9, 20).getTime();
      assert.equal(s.totals.today_active_sessions,
        store.db.prepare('SELECT COUNT(DISTINCT session_id) n FROM events WHERE ts >= ?').get(todayStart).n);
    });

    await check('warm call reuses the cache and equals a cold recompute', async () => {
      historyQueries = 0;
      await same('warm');
      assert.equal(historyQueries, 0);
    });

    await check("today's writes keep the cache and still show up", async () => {
      ev(store, NOW - 30 * 60_000, { session_id: 'today-new' });
      historyQueries = 0;
      await same('after today insert');
      assert.equal(historyQueries, 0);
    });

    for (const [label, mutate] of [
      ['history insert', () => ev(store, days(3) + H)],
      ['history UPDATE (model backfill)', () => store.db.prepare(
        "UPDATE events SET model = 'deepseek-v4-pro' WHERE model IS NULL").run()],
      ['history DELETE', () => store.db.prepare("DELETE FROM events WHERE model = 'mystery-model' AND ts < ?").run(days(20))],
      ['row moved from today into history', () => store.db.prepare(
        "UPDATE events SET ts = ? WHERE session_id = 'today-new'").run(days(2))],
      ['write from another connection', () => { const o = new Store(file); try { ev(o, days(5)); } finally { o.close(); } }],
    ]) {
      await check(`invalidates on ${label}`, async () => {
        await summary(store);
        mutate();
        historyQueries = 0;
        await same(label);
        assert.ok(historyQueries > 0, 'history was not recomputed');
      });
    }

    await check('rolled-back history write leaves the cache valid', async () => {
      await summary(store);
      store.db.exec('BEGIN');
      ev(store, days(4));
      store.db.exec('ROLLBACK');
      historyQueries = 0;
      await same('after rollback');
      assert.equal(historyQueries, 0);
    });

    // 事务内读取后回滚：dirty 随事务回滚，若事务里重建过缓存就会停在已撤销的行上（#17 review）
    const byDayAll = () => store.db.prepare(`SELECT date(ts/1000, 'unixepoch', 'localtime') d, SUM(total_tokens) total
      FROM events GROUP BY d ORDER BY d`).all().map(x => ({ d: x.d, total: x.total }));
    for (const [label, hide] of [['db.isTransaction', false], ['BEGIN probe (Node < 22.16)', true]]) {
      await check(`read inside a rolled-back transaction does not poison the cache (${label})`, async () => {
        const real = store.db;
        // isTransaction 不可重定义：用 Proxy 遮住它，走 BEGIN 试探分支
        if (hide) store.db = new Proxy(real, {
          get: (t, k) => (k === 'isTransaction' ? undefined : typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
        });
        try {
          ev(store, days(6));
          await summary(store);
          store.db.exec('BEGIN');
          try {
            ev(store, days(6) + H, { total_tokens: 99_999 });
            const inside = await summary(store);
            assert.deepEqual(inside.by_day_all, byDayAll(), 'sees its own uncommitted history row');
          } finally {
            store.db.exec('ROLLBACK');
          }
          await same('after rollback');
        } finally {
          store.db = real;
        }
      });
    }

    await check('crossing midnight moves the boundary', async () => {
      await summary(store);
      historyQueries = 0;
      await same('next day', NOW + D);
      assert.ok(historyQueries > 0);
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
