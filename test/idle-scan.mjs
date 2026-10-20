/** 空闲重扫开销：Codex 模型回填只碰缺模型的行，且没有 Codex 文件变化的轮次直接跳过。 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { SOURCES } from '../src/config.js';

const stamp = n => new Date(Date.parse('2026-09-20T10:00:00Z') + n * 1000).toISOString();
const usage = n => ({ input_tokens: 100 * n, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 10 * n, reasoning_output_tokens: 0, total_tokens: 110 * n });
const meta = (n, parent) => JSON.stringify({ timestamp: stamp(n), type: 'session_meta',
  payload: { cwd: '/work/idle', ...(parent ? { parent_thread_id: parent } : {}) } });
const model = n => JSON.stringify({ timestamp: stamp(n), type: 'event_msg', payload: {
  type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.5' } } });
const token = (n, k) => JSON.stringify({ timestamp: stamp(n), type: 'event_msg', payload: {
  type: 'token_count', info: { total_token_usage: usage(k), last_token_usage: usage(1) } } });
const lines = (...r) => `${r.join('\n')}\n`;

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';

export async function testIdleScan(ok) {
  console.log('\n[scan] 空闲重扫：Codex 模型回填');
  const root = mkdtempSync(join(tmpdir(), 'tw-idle-'));
  const originalRoots = SOURCES.map(s => s.roots);
  const sessions = join(root, 'sessions', '2026', '09', '20');
  mkdirSync(sessions, { recursive: true });
  SOURCES.forEach(s => { s.roots = []; });
  SOURCES.find(s => s.tool === 'codex').roots = [join(root, 'sessions')];
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); } catch (err) { ok(name, false, err.stack); }
  };
  const parentPath = join(sessions, `rollout-2026-09-20T10-00-00-${PARENT}.jsonl`);
  const childPath = join(sessions, `rollout-2026-09-20T10-05-00-${CHILD}.jsonl`);
  const dbPath = join(root, 'tm.db');
  const store = new Store(dbPath);
  const nullModels = (s = store) => s.db.prepare(
    "SELECT COUNT(*) n FROM events WHERE tool = 'codex' AND model IS NULL").get().n;
  // 统计回填次数：包一层实例方法，不改行为
  const counted = (scanner) => {
    let n = 0;
    const orig = scanner._inheritCodexModels.bind(scanner);
    scanner._inheritCodexModels = () => { n++; orig(); };
    return { scanner, runs: () => n };
  };

  try {
    await check('backfill UPDATE uses the partial NULL-model index', async () => {
      // 截下扫描器实际准备的语句，对它取查询计划（空库上规划器自己不会选这个索引）
      const sqls = [];
      const prepare = store.db.prepare.bind(store.db);
      store.db.prepare = (sql) => { sqls.push(sql); return prepare(sql); };
      try { new Scanner(store)._inheritCodexModels(); } finally { delete store.db.prepare; }
      const upd = sqls.find(q => /^\s*UPDATE events\b/.test(q) && /model IS NULL/.test(q));
      assert.ok(upd, 'backfill UPDATE not prepared');
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${upd}`).all('m', 's').map(r => r.detail).join(' | ');
      assert.match(plan, /idx_events_model_null/, plan);
    });

    const { scanner, runs } = counted(new Scanner(store));
    await check('first scan runs the backfill; parent model unknown leaves NULLs', async () => {
      // 父会话还没写出模型：子会话（resume 链）此时无从继承
      writeFileSync(parentPath, lines(meta(0), token(10, 1)));
      writeFileSync(childPath, lines(meta(300, PARENT), token(310, 1), token(320, 2)));
      await scanner.scanAll({ quiet: true });
      assert.equal(runs(), 1);
      assert.equal(nullModels(), 3);
    });

    await check('idle rescan with no Codex change skips the backfill', async () => {
      await scanner.scanAll({ quiet: true });
      await scanner.scanAll({ quiet: true });
      assert.equal(runs(), 1);
    });

    await check('parent model appearing later is inherited by the child', async () => {
      appendFileSync(parentPath, lines(model(20), token(30, 2)));
      await scanner.scanAll({ quiet: true });
      assert.equal(runs(), 2);
      assert.equal(nullModels(), 0);
      const models = store.db.prepare(
        "SELECT DISTINCT model FROM events WHERE tool = 'codex'").all().map(r => r.model);
      assert.deepEqual(models, ['gpt-5.5']);
    });

    await check('a new scanner instance backfills once even when nothing changed', async () => {
      // 模拟旧版本 / 中断留下的空模型
      store.db.exec("UPDATE events SET model = NULL WHERE tool = 'codex'");
      const fresh = counted(new Scanner(store));
      await fresh.scanner.scanAll({ quiet: true });
      assert.equal(fresh.runs(), 1);
      assert.equal(nullModels(), 0);
      await fresh.scanner.scanAll({ quiet: true });
      assert.equal(fresh.runs(), 1);
    });
  } finally {
    store.close();
    SOURCES.forEach((s, i) => { s.roots = originalRoots[i]; });
    rmSync(root, { recursive: true, force: true });
  }
}
