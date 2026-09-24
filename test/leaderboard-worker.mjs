import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../cloud/worker.js';
import { fetchLeaderboard } from '../src/leaderboard.js';

// Real SQLite executes the Worker's SQL; only the D1 transport shape is adapted.
// This complements (does not replace) Wrangler/workerd and deployed D1 checks.
export async function testLeaderboardWorker(ok) {
  console.log('\n[LB Worker] 云端 SQL 与协议（内存 SQLite）');
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../cloud/schema.sql', import.meta.url), 'utf8'));
  const legacy = new DatabaseSync(':memory:');
  try {
    legacy.exec(readFileSync(new URL('../cloud/schema.sql', import.meta.url), 'utf8')
      .split('\n').filter(line => !line.includes('month_tokens') && !line.includes('models_by_period_json')).join('\n'));
    legacy.prepare('INSERT INTO players (id, name, updated_at) VALUES (?, ?, ?)').run('existing', '原有用户', 123);
    legacy.exec(readFileSync(new URL('../cloud/migrations/0001_month_tokens.sql', import.meta.url), 'utf8'));
    legacy.exec(readFileSync(new URL('../cloud/migrations/0002_period_models.sql', import.meta.url), 'utf8'));
    const row = legacy.prepare('SELECT * FROM players').get();
    ok('迁移保留原记录且月字段为空', row.name === '原有用户' && row.updated_at === 123 && row.month_tokens === null && row.models_by_period_json === null);
  } finally { legacy.close(); }
  const clock = Date.now;
  const now = Date.parse('2026-09-24T08:00:00Z');
  Date.now = () => now;
  const env = {
    DB: { prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async run() { return { meta: { changes: Number(stmt.run(...args).changes) } }; },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
      };
    } },
    RATE_LIMITER: { async limit() { return { success: true }; } },
  };
  const makeReport = (overrides = {}) => ({ v: 1, id: crypto.randomUUID(), name: '测试用户',
    day: '2026-09-24', day_tokens: 100, day_requests: 2, week_tokens: 1000,
    roi_ratio: null, models: [['test-model', 100]], tools: [['codex', 100]], ...overrides });
  const post = (report, target = env) => worker.fetch(new Request('https://worker.test/report', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report),
  }), target);
  const board = (period = 'day', id) => fetchLeaderboard({ url: 'https://worker.test', period, id,
    fetchImpl: (url, opts) => worker.fetch(new Request(url, opts), env) });
  try {
    const initial = makeReport();
    ok('有效上报写入一次', (await post(initial)).status === 200 && db.prepare('SELECT COUNT(*) n FROM players').get().n === 1);
    ok('重复上报返回 429，不谎报成功', (await post({ ...initial, day_tokens: 999 })).status === 429 &&
      db.prepare('SELECT day_tokens FROM players').get().day_tokens === 100);
    ok('非法 ID 被拒', (await post(makeReport({ id: 'guessable-id' }))).status === 400);
    ok('截断后的 ID 不可冒用合法 ID', (await post(makeReport({ id: initial.id + 'x'.repeat(80) }))).status === 400);
    ok('旧日期上报被拒', (await post(makeReport({ day: '2026-09-23' }))).status === 400);
    ok('无效日期上报被拒', (await post(makeReport({ day: '2026-99-99' }))).status === 400);
    ok('协议版本被检查', (await post(makeReport({ v: 2 }))).status === 400);
    ok('大包在写库前被拒', (await post(makeReport({ extra: 'x'.repeat(17000) }))).status === 413);
    ok('限流失败不写数据库', (await post(makeReport(), { ...env,
      RATE_LIMITER: { async limit() { return { success: false }; } } })).status === 429);
    ok('限流绑定缺失时关闭写入', (await post(makeReport(), { DB: env.DB })).status === 503);
    ok('请求体格式错误返回 400', (await worker.fetch(new Request('https://worker.test/report', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
    }), env)).status === 400);
    ok('普通表单不可跨站上报', (await worker.fetch(new Request('https://worker.test/report', {
      method: 'POST', body: JSON.stringify(makeReport()),
    }), env)).status === 415);

    let last;
    for (let i = 0; i < 205; i++) {
      last = makeReport({ day_tokens: 1000 - i, week_tokens: 10000 - i });
      await post(last);
    }
    const ranked = await board('day', last.id);
    ok('榜单只展示 50 人但返回第 205 名', ranked.rows.length === 50 && ranked.me_rank === 205 && ranked.players === 206);
    ok('公开响应不含任何匿名 ID', !JSON.stringify(ranked).includes(last.id) && !JSON.stringify(ranked).includes(initial.id));
    ok('日榜公开 UTC 口径', ranked.timezone === 'UTC' && ranked.day === '2026-09-24');

    const monthly = makeReport({ month_tokens: 987654, day_tokens: 1, week_tokens: 2,
      models_by_period: { day: [['claude-opus-5-5', 90]], week: [['claude-opus-5', 70]], month: [['month-model', 60]] } });
    await post(monthly);
    const monthBoard = await board('month', monthly.id);
    ok('月榜按独立 30 日总量排序，旧客户端不进入', monthBoard.period === 'month' &&
      monthBoard.players === 1 && monthBoard.me_rank === 1 && monthBoard.me.month_tokens === 987654);
    ok('旧客户端的日周榜保留且月用量为未知', (await board('week', initial.id)).me.month_tokens === null);
    for (const [period, model, share] of [['day', 'claude-opus-5-5', 90], ['week', 'claude-opus-5', 70], ['month', 'month-model', 60]]) {
      const me = (await board(period, monthly.id)).me;
      ok(period + ' 返回自己的周期模型和占比', me.models_period === period && me.models.length === 1 && me.models[0][0] === model && me.models[0][1] === share);
    }
    ok('旧记录日榜不拿周主力代替', (await board('day', initial.id)).me.models.length === 0 && (await board('day', initial.id)).me.models_period === null);
    ok('旧记录周榜仍可显示周主力', (await board('week', initial.id)).me.models[0][0] === 'test-model');
    db.prepare('UPDATE players SET day = ? WHERE id = ?').run('2026-09-23', monthly.id);
    ok('跨午夜的 30 日快照仍可显示', (await board('month', monthly.id)).me_rank === 1);
    db.prepare('UPDATE players SET updated_at = ? WHERE id = ?').run(now - 25 * 3600000, monthly.id);
    ok('超过 24h 的月快照退出榜单', (await board('month', monthly.id)).me_rank === null);
    db.prepare('UPDATE players SET updated_at = ? WHERE id = ?').run(now - 61000, monthly.id);
    await post({ ...monthly, month_tokens: undefined, models_by_period: undefined });
    ok('回退旧客户端后清空过期月快照', (await board('month', monthly.id)).me_rank === null);

    ok('旧客户端覆盖时不残留旧周期模型', (await board('day', monthly.id)).me.models_period === null);

    const oldDay = makeReport({ day_tokens: 9999999, week_tokens: 9999999 });
    await post(oldDay);
    db.prepare('UPDATE players SET day = ? WHERE id = ?').run('2026-09-23', oldDay.id);
    ok('跨午夜旧日数据退出日榜', (await board('day', oldDay.id)).me_rank === null);
    ok('昨日更新的滚动周快照仍可显示', (await board('week', oldDay.id)).me_rank === 1);
    db.prepare('UPDATE players SET updated_at = ? WHERE id = ?').run(now - 25 * 3600000, oldDay.id);
    ok('超过 24h 的周快照退出榜单', (await board('week', oldDay.id)).me_rank === null);
    db.prepare('UPDATE players SET updated_at = ? WHERE id = ?').run(now - 31 * 86400000, oldDay.id);
    await worker.scheduled({}, env);
    ok('无新上报也可定时清除 30 天旧记录', !db.prepare('SELECT id FROM players WHERE id = ?').get(oldDay.id));
    ok('健康检查验证真实表存在', (await worker.fetch(new Request('https://worker.test/healthz'), env)).status === 200);
    ok('缺表时健康检查失败', (await worker.fetch(new Request('https://worker.test/healthz'), {
      DB: { prepare() { throw new Error('missing table'); } },
    })).status === 500);
    let requested;
    await fetchLeaderboard({ id: initial.id, fetchImpl: async (url, options) => {
      requested = { url, options }; return { ok: true, json: async () => ({ rows: [] }) };
    } });
    ok('匿名 ID 走请求头而非 URL', !requested.url.includes(initial.id) &&
      requested.options.headers['X-Leaderboard-ID'] === initial.id);
    const response = await worker.fetch(new Request('https://worker.test/leaderboard'), env);
    ok('个人排名不会进入共享缓存', response.headers.get('cache-control') === 'no-store');
  } finally {
    Date.now = clock;
    db.close();
  }
}
