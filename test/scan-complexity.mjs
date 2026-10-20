import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { readLinesFrom } from '../src/collectors/lines.js';

/**
 * 两处随数据量平方增长的热点，用确定性的信号断言（查询计划、拼接次数），不靠计时：
 * - dropStaleCodexRows：Codex 首扫每个文件调用一次。DELETE 曾走 idx_events_tool_ts、
 *   files 按 session_id 查无索引，每个文件都全表扫一遍（5000 文件首扫 114s）。
 * - readLinesFrom：超长单行跨很多 chunk 时每块都把残行重新 concat（64MB 单行 25s）。
 */
export async function testScanComplexity(ok) {
  console.log('\n[scan] Codex first-scan query plans / long-line reader');
  const root = mkdtempSync(join(tmpdir(), 'tw-complexity-'));
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); } catch (err) { ok(name, false, err.stack); }
  };
  try {
    await check('dropStaleCodexRows: every statement uses an index, DELETE ranges on dedup_key', () => {
      const store = new Store(join(root, 'plan.db'));
      try {
        const seen = [];
        const prepare = store.db.prepare.bind(store.db);
        store.db.prepare = (sql) => { seen.push(sql); return prepare(sql); };
        store.dropStaleCodexRows('rollout-2026-10-20T00-00-00-x', '/codex/a.jsonl', 99);
        store.db.prepare = prepare;
        assert.equal(seen.length, 3, seen.join('\n'));
        for (const sql of seen) {
          const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all('a', 'b').map(r => r.detail).join(' | ');
          assert.doesNotMatch(plan, /\bSCAN\b/, `${sql}\n→ ${plan}`);
          if (sql.startsWith('DELETE')) assert.match(plan, /dedup_key>\? AND dedup_key<\?/, `${sql}\n→ ${plan}`);
        }
      } finally { store.close(); }
    });

    await check('dropStaleCodexRows still removes only its own stem and keeps current siblings', () => {
      const store = new Store(join(root, 'rows.db'));
      try {
        const ev = (key) => store.insertEvent({ ts: 1, tool: 'codex', total_tokens: 1, dedup_key: key });
        ev('codex:file:stem-a:1'); ev('codex:file:stem-a:2'); ev('codex:file:stem-ab:1');
        store.insertToolCall({ ts: 1, tool: 'codex', name: 'shell', dedup_key: 'codex:tc:file:stem-a:c1' });
        assert.equal(store.dropStaleCodexRows('stem-a', '/x/stem-a.jsonl', 5), true);
        const keys = store.db.prepare('SELECT dedup_key FROM events ORDER BY dedup_key').all().map(r => r.dedup_key);
        assert.deepEqual(keys, ['codex:file:stem-ab:1']);
        assert.equal(store.db.prepare('SELECT COUNT(*) n FROM tool_calls').get().n, 0);

        ev('codex:file:stem-a:1');
        store.saveFile({ path: '/y/stem-a.jsonl', tool: 'codex', session_id: 'stem-a', size: 1, mtime_ms: 1, offset: 1, state_json: '{"_v":5}' });
        assert.equal(store.dropStaleCodexRows('stem-a', '/x/stem-a.jsonl', 5), false);
        assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE dedup_key = 'codex:file:stem-a:1'").get().n, 1);
      } finally { store.close(); }
    });

    await check('readLinesFrom: a 16 MiB line is joined once, not once per chunk', async () => {
      const file = join(root, 'long.jsonl');
      const big = 'x'.repeat(16 * 1024 * 1024);
      writeFileSync(file, `{"a":1}\n{"big":"${big}"}\n{"b":2}\n`);
      const concat = Buffer.concat;
      let calls = 0;
      Buffer.concat = (...args) => { calls++; return concat(...args); };
      const lines = [];
      let result;
      try { result = await readLinesFrom(file, 0, (l) => lines.push(l.length)); }
      finally { Buffer.concat = concat; }
      assert.deepEqual(lines, [7, big.length + 10, 7]);
      assert.ok(calls <= 2, `Buffer.concat called ${calls} times`);
      assert.equal(result.newOffset, 7 + 1 + big.length + 10 + 1 + 7 + 1);
    });

    await check('readLinesFrom: multibyte chars split across chunks, trailing partial line not consumed', async () => {
      const file = join(root, 'utf8.jsonl');
      const line = '用'.repeat(40_000); // 120 000 bytes，跨两块 64KiB chunk，切点落在字符中间
      writeFileSync(file, `${line}\n`);
      appendFileSync(file, 'x'.repeat(200_000)); // 正在写入的半行，跨多块且无换行
      const lines = [];
      const { newOffset } = await readLinesFrom(file, 0, (l) => lines.push(l));
      assert.deepEqual(lines, [line]);
      assert.equal(newOffset, Buffer.byteLength(line) + 1);
      appendFileSync(file, '\n');
      const rest = [];
      const again = await readLinesFrom(file, newOffset, (l) => rest.push(l.length));
      assert.deepEqual(rest, [200_000]);
      assert.equal(again.newOffset, newOffset + 200_001);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
