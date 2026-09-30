/**
 * 榜单防伪造：服务端不能信任客户端报来的任何数字。
 *
 * 用量是用户本机日志算出来的，代码开源，签名密钥藏不住，所以做不到"证明是真的"。
 * 能做的是让造假变难、变显眼、可处理：
 *   1. 不合理就拒收（超限、自相矛盾、增长快于物理可能），不再截断到上限——截断会把造假者送上第一
 *   2. 7 天 / 30 天由服务端按天累计，不采用客户端报的滚动总量
 *   3. 封禁表：被封 ID 的上报一律拒收，删掉的行不会在下一小时被插回
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../cloud/worker.js';
import { banSql, unbanSql, findSql } from '../cloud/admin.mjs';

const schema = readFileSync(new URL('../cloud/schema.sql', import.meta.url), 'utf8');

/** 内存 SQLite 模拟 D1：prepare/bind/run/first/all + batch（事务内顺序执行） */
function d1(db) {
  const wrap = (sql) => {
    const stmt = db.prepare(sql);
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() { return { meta: { changes: Number(stmt.run(...args).changes) } }; },
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
      _run() { return { meta: { changes: Number(stmt.run(...args).changes) } }; },
    };
  };
  return {
    prepare: wrap,
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._run()); db.exec('COMMIT'); return out; }
      catch (err) { db.exec('ROLLBACK'); throw err; }
    },
  };
}

export async function testLeaderboardAntiForgery(ok) {
  console.log('\n[LB 防伪] 服务端不信任客户端数字');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const env = { DB: d1(db), RATE_LIMITER: { async limit() { return { success: true }; } } };
  const clock = Date.now;
  let now = Date.parse('2026-09-30T12:00:00Z'); // UTC 正午：当日已过 12 小时
  Date.now = () => now;
  const makeReport = (overrides = {}) => ({ v: 1, id: crypto.randomUUID(), name: '测试用户',
    day: new Date(now).toISOString().slice(0, 10), day_tokens: 5e8, day_requests: 3000,
    week_tokens: 3e9, month_tokens: 1e10, roi_ratio: null,
    models: [['test-model', 100]], tools: [['codex', 100]], ...overrides });
  const post = (report) => worker.fetch(new Request('https://worker.test/report', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report),
  }), env);
  const board = async (period, id) => (await worker.fetch(new Request(`https://worker.test/leaderboard?period=${period}`,
    { headers: id ? { 'X-Leaderboard-ID': id } : {} }), env)).json();
  const count = () => db.prepare('SELECT COUNT(*) n FROM players').get().n;

  try {
    // 真实案例：各字段都填天文数字，服务端截断到上限后排到第一
    const forged = makeReport({ name: 'Uzuki', day_tokens: 1e20, day_requests: 1e20, week_tokens: 1e20, month_tokens: 1e20 });
    const before = count();
    ok('天文数字直接拒收，不截断到上限', (await post(forged)).status === 400 && count() === before);
    ok('单日 token 超过 200 亿拒收', (await post(makeReport({ day_tokens: 2.1e10, week_tokens: 2.1e10, month_tokens: 2.1e10, day_requests: 1e5 }))).status === 400);
    ok('单日请求超过 20 万拒收', (await post(makeReport({ day_requests: 2.1e5 }))).status === 400);
    ok('负数、非数字拒收', (await post(makeReport({ day_tokens: -1 }))).status === 400 &&
      (await post(makeReport({ week_tokens: 'lots' }))).status === 400);
    ok('有用量却零请求拒收', (await post(makeReport({ day_requests: 0 }))).status === 400);
    ok('平均每次请求超过 500 万 token 拒收', (await post(makeReport({ day_tokens: 6e9, day_requests: 1000 }))).status === 400);
    ok('自相矛盾拒收：30 天 < 7 天', (await post(makeReport({ week_tokens: 3e9, month_tokens: 1e9 }))).status === 400);
    ok('自相矛盾拒收：7 天 < 今天', (await post(makeReport({ day_tokens: 5e8, week_tokens: 1e8 }))).status === 400);
    ok('被拒的上报一条都没写入', count() === before);
    ok('真实重度用户的量照常接受（单日 11.2 亿 / 6355 次）',
      (await post(makeReport({ day_tokens: 1.12e9, day_requests: 6355, week_tokens: 6e9, month_tokens: 2e10 }))).status === 200);

    // ---- 第 2 层：增速与服务端累计 ----
    now = Date.parse('2026-09-30T00:30:00Z');
    ok('零点半就报 150 亿：增长快于可能，拒收',
      (await post(makeReport({ day_tokens: 1.5e10, day_requests: 1e5, week_tokens: 1.5e10, month_tokens: 1.5e10 }))).status === 400);
    ok('零点半报 5 亿照常接受', (await post(makeReport({ day_tokens: 5e8, week_tokens: 1e9, month_tokens: 1e9 }))).status === 200);

    now = Date.parse('2026-09-30T12:00:00Z');
    const alice = makeReport({ name: 'alice', day_tokens: 4e8, week_tokens: 9e9, month_tokens: 3e10, day_requests: 2000 });
    await post(alice);
    let me = (await board('month', alice.id)).me;
    ok('7 天 / 30 天不采用客户端报的总量，只算服务端见过的天', me.week_tokens === 4e8 && me.month_tokens === 4e8, JSON.stringify(me));

    now += 3600_000;
    ok('同一天再报：当天取最新值', (await post({ ...alice, day_tokens: 6e8, week_tokens: 9.2e9, month_tokens: 3.02e10 })).status === 200);
    // 同一毫秒的重放：节流拦下了玩家行，当天记录也不能被它写进去
    ok('节流中的上报不写入按天记录', (await post({ ...alice, day_tokens: 7e8, week_tokens: 9.3e9, month_tokens: 3.03e10 })).status === 429);
    me = (await board('week', alice.id)).me;
    ok('当天值被最新一次覆盖，不是累加', me.day_tokens === 6e8 && me.week_tokens === 6e8, JSON.stringify(me));

    for (let d = 1; d <= 8; d++) {
      now = Date.parse('2026-09-30T12:00:00Z') + d * 86400_000;
      await post({ ...alice, day: new Date(now).toISOString().slice(0, 10), day_tokens: 1e8, week_tokens: 1e9, month_tokens: 3e10 });
    }
    // 第 0 天 6 亿 + 之后 8 天各 1 亿；7 天窗口只含最近 7 个 UTC 自然日
    me = (await board('week', alice.id)).me;
    ok('7 天 = 最近 7 个 UTC 自然日之和', me.week_tokens === 7e8, JSON.stringify(me));
    me = (await board('month', alice.id)).me;
    ok('30 天 = 服务端见过的最近 30 天之和', me.month_tokens === 6e8 + 8e8, JSON.stringify(me));

    const legacy = makeReport({ name: 'legacy', month_tokens: undefined, day_tokens: 2e8, week_tokens: 2e8 });
    await post(legacy);
    ok('旧客户端（不报 30 天）也按服务端累计进 30 天榜', (await board('month', legacy.id)).me?.month_tokens === 2e8);

    // ---- 第 3 层：封禁 ----
    const found = db.prepare(findSql('alice')).all();
    ok('按昵称查到 ID（仅管理员经 wrangler 可见，公开接口不返回）', found.length === 1 && found[0].id === alice.id);
    ok('昵称里的引号不会破坏查询', db.prepare(findSql("x' OR '1'='1")).all().length === 0);
    db.exec(banSql(alice.id, "刷榜 'Uzuki'"));
    ok('封禁后玩家行与按天记录都删除', !db.prepare('SELECT 1 FROM players WHERE id = ?').get(alice.id) &&
      !db.prepare('SELECT 1 FROM daily WHERE id = ?').get(alice.id));
    now += 3600_000;
    const again = await post({ ...alice, day: new Date(now).toISOString().slice(0, 10) });
    ok('被封 ID 再上报返回 403，不会被插回', again.status === 403 && !db.prepare('SELECT 1 FROM players WHERE id = ?').get(alice.id));
    ok('封禁不影响其他人', (await board('month', legacy.id)).me?.month_tokens === 2e8);
    let threw = false;
    try { banSql("1'; DROP TABLE players; --"); } catch { threw = true; }
    ok('非法 ID 拒绝生成 SQL（防注入）', threw);
    db.exec(unbanSql(alice.id));
    ok('解封后可以重新上报', (await post({ ...alice, day: new Date(now).toISOString().slice(0, 10) })).status === 200);
  } finally {
    Date.now = clock;
    db.close();
  }
}
