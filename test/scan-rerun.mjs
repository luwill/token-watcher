/** 扫描进行中收到的扫描请求不能丢：本轮结束后经防抖补一轮，stop() 之后不再补。 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { SOURCES } from '../src/config.js';

const stamp = n => new Date(Date.parse('2026-09-20T10:00:00Z') + n * 1000).toISOString();
const usage = n => ({ input_tokens: 100 * n, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 10 * n, reasoning_output_tokens: 0, total_tokens: 110 * n });
const rollout = () => [
  JSON.stringify({ timestamp: stamp(0), type: 'session_meta', payload: { cwd: '/work/rerun' } }),
  JSON.stringify({ timestamp: stamp(10), type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: usage(1), last_token_usage: usage(1) } } }),
].join('\n') + '\n';

export async function testScanRerun(ok) {
  console.log('\n[scan] 扫描中途的扫描请求');
  const root = mkdtempSync(join(tmpdir(), 'tw-rerun-'));
  const originalRoots = SOURCES.map(s => s.roots);
  const sessions = join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  SOURCES.forEach(s => { s.roots = []; });
  SOURCES.find(s => s.tool === 'codex').roots = [sessions];
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); } catch (err) { ok(name, false, err.stack); }
  };
  let n = 0;
  const write = () => writeFileSync(join(sessions, `rollout-2026-09-20T10-00-0${n}-${String(n++).repeat(8)}-0000-4000-8000-000000000000.jsonl`), rollout());

  /** 记录每次完成的扫描；waitScan 等下一次真正执行（未被并发挡掉）的扫描 */
  const instrument = (scanner) => {
    const done = [];
    let wake = null;
    const orig = scanner.scanAll.bind(scanner);
    scanner.scanAll = async (opts) => {
      const r = await orig(opts);
      done.push(r);
      if (!r.skippedConcurrent) wake?.();
      return r;
    };
    const waitScan = (ms) => new Promise((resolve) => {
      const t = setTimeout(() => { wake = null; resolve(false); }, ms);
      wake = () => { clearTimeout(t); wake = null; resolve(true); };
    });
    return { done, waitScan };
  };

  try {
    await check('a scan requested mid-scan runs again after the current one', async () => {
      const store = new Store(join(root, 'a.db'));
      const scanner = new Scanner(store);
      const { done, waitScan } = instrument(scanner);
      try {
        write();
        const first = scanner.scanAll({ quiet: true });
        write(); // 当前这轮可能已经枚举过目录
        assert.deepEqual(await scanner.scanAll({ quiet: true }), { skippedConcurrent: true });
        await first;
        const next = waitScan(5000);
        assert.ok(await next, 'no follow-up scan within 5 s');
        assert.equal(done.filter(r => !r.skippedConcurrent).length, 2);
        assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE tool = 'codex'").get().n, n);
      } finally {
        scanner.stop();
        store.close();
      }
    });

    await check('no follow-up is scheduled when nothing was requested mid-scan', async () => {
      const store = new Store(join(root, 'b.db'));
      const scanner = new Scanner(store);
      try {
        await scanner.scanAll({ quiet: true });
        assert.equal(scanner._debounceTimer, null);
      } finally {
        scanner.stop();
        store.close();
      }
    });

    await check('stop() during a scan cancels the follow-up', async () => {
      const store = new Store(join(root, 'c.db'));
      const scanner = new Scanner(store);
      try {
        const first = scanner.scanAll({ quiet: true });
        await scanner.scanAll({ quiet: true });
        scanner.stop();
        await first;
        assert.equal(scanner._debounceTimer, null);
      } finally {
        store.close();
      }
    });
  } finally {
    SOURCES.forEach((s, i) => { s.roots = originalRoots[i]; });
    rmSync(root, { recursive: true, force: true });
  }
}
