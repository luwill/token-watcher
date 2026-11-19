/**
 * 模型测速：从日志推算单次请求耗时（duration_ms）与输出速度。
 * Claude Code / ccmr：api-request.id ↔ assistant.requestRef，耗时 = 末个 content block 落盘 − 请求发出（实测）。
 * Codex：耗时 = token_count − 最近一次触发请求的事件（轮次开始 / 工具输出 / 上一次响应），近似值。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { collectClaudeFile } from '../src/collectors/claude.js';
import { collectCodexFile } from '../src/collectors/codex.js';
import { modelSpeed } from '../src/speed.js';

const iso = (s) => new Date(Date.UTC(2026, 10, 18, 8, 0, 0) + s * 1000).toISOString();
const jl = (rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const apiRequest = (id, s) => ({ type: 'api-request', sessionId: 'sess', id, timestamp: iso(s), params: { big: 'x'.repeat(2000) } });
const block = (msgId, ref, s, output, type = 'text') => ({
  type: 'assistant', timestamp: iso(s), sessionId: 'sess', requestId: `req_${msgId}`, requestRef: ref, cwd: '/w/p',
  message: { id: msgId, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output }, content: [{ type }] },
});

export async function testModelSpeed(ok) {
  console.log('\n[测速] 请求耗时与输出速度');
  const root = mkdtempSync(join(tmpdir(), 'tw-speed-'));
  const stores = [];
  const check = async (name, fn) => { try { await fn(); ok(name, true); } catch (err) { ok(name, false, err.stack?.slice(0, 400)); } };
  const mk = () => { const s = new Store(join(root, `s${stores.length}.db`)); stores.push(s); return s; };
  const run = async (store, collect, args) => {
    const staged = store.stageWrites();
    const r = await collect(staged.store, args);
    staged.replay();
    return r;
  };
  const duration = (store, key) => store.db.prepare('SELECT duration_ms d FROM events WHERE dedup_key = ?').get(key)?.d ?? null;

  try {
    await check('Claude：耗时取末个 content block − api-request（官方每行重复 output 也取最大）', async () => {
      const store = mk();
      const p = join(root, 'claude-a.jsonl');
      writeFileSync(p, jl([apiRequest('r1', 0), block('m1', 'r1', 2, 300, 'thinking'), block('m1', 'r1', 3, 300), block('m1', 'r1', 6, 300)]));
      await run(store, collectClaudeFile, { tool: 'claude-code', path: p, fileId: 'a', offset: 0 });
      assert.equal(duration(store, 'claude-code:message:m1'), 6000);
    });

    await check('Claude：api-request 与回复跨两次增量扫描仍能配对（状态随游标持久化）', async () => {
      const store = mk();
      const p = join(root, 'claude-b.jsonl');
      writeFileSync(p, jl([apiRequest('r2', 0)]));
      const first = await run(store, collectClaudeFile, { tool: 'claude-code', path: p, fileId: 'b', offset: 0 });
      appendFileSync(p, jl([block('m2', 'r2', 4, 100)]));
      await run(store, collectClaudeFile, { tool: 'claude-code', path: p, fileId: 'b', offset: first.newOffset, state: first.state });
      assert.equal(duration(store, 'claude-code:message:m2'), 4000);
    });

    await check('Claude：游标状态只留可能还会配对的请求（离文件最新一行 15 分钟内）', async () => {
      const store = mk();
      const p = join(root, 'claude-prune.jsonl');
      const rows = [];
      for (let i = 0; i < 50; i++) rows.push(apiRequest(`old${i}`, i), block(`mo${i}`, `old${i}`, i + 1, 50));
      rows.push(apiRequest('fresh', 3000)); // 最后一行：比旧请求晚 ~49 分钟，回复尚未写出
      writeFileSync(p, jl(rows));
      const r = await run(store, collectClaudeFile, { tool: 'claude-code', path: p, fileId: 'prune', offset: 0 });
      assert.deepEqual(Object.keys(r.state.reqs), ['fresh']);
    });

    await check('Claude：没有 requestRef 或找不到请求、耗时越界 → 不记耗时', async () => {
      const store = mk();
      const p = join(root, 'claude-c.jsonl');
      const noRef = block('m3', undefined, 5, 50); delete noRef.requestRef;
      writeFileSync(p, jl([noRef, block('m4', 'missing', 5, 50), apiRequest('r5', 0), block('m5', 'r5', 3600, 50)]));
      await run(store, collectClaudeFile, { tool: 'claude-code', path: p, fileId: 'c', offset: 0 });
      assert.equal(duration(store, 'claude-code:message:m3'), null);
      assert.equal(duration(store, 'claude-code:message:m4'), null);
      assert.equal(duration(store, 'claude-code:message:m5'), null);
    });

    await check('ccmr 同一解析器：耗时写到 msg.id+requestId 键上', async () => {
      const store = mk();
      const p = join(root, 'ccmr.jsonl');
      writeFileSync(p, jl([apiRequest('r6', 0), block('m6', 'r6', 2.5, 80)]));
      await run(store, collectClaudeFile, { tool: 'ccmr', path: p, fileId: 'd', offset: 0 });
      assert.equal(duration(store, 'ccmr:m6:req_m6'), 2500);
    });

    await check('Codex：按真实落盘顺序（响应记录 → 工具输出 → token_count），耗时 = 响应记录 − 之前最近的触发事件', async () => {
      const store = mk();
      const p = join(root, 'rollout-2026-11-18T08-00-00-0000.jsonl');
      const u = (n) => ({ input_tokens: n, cached_input_tokens: 0, output_tokens: n / 10, reasoning_output_tokens: 0, total_tokens: n + n / 10 });
      const rec = (s, id, n) => ({ timestamp: iso(s), type: 'token_usage_record', payload: { response_id: id, session_id: 'x', usage: u(n) } });
      const tc = (s, total, last) => ({ timestamp: iso(s), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u(total), last_token_usage: u(last) } } });
      const toolOut = (s) => ({ timestamp: iso(s), type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'y'.repeat(500) } });
      writeFileSync(p, jl([
        { timestamp: iso(0), type: 'session_meta', payload: { id: 'x', cwd: '/w/p' } },
        { timestamp: iso(0.1), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra' } } },
        { timestamp: iso(10), type: 'event_msg', payload: { type: 'task_started' } },
        rec(16, 'r1', 1000), toolOut(18), tc(18.001, 1000, 1000),   // 第 1 次：10 → 16
        rec(21, 'r2', 2000), tc(21.2, 3000, 2000),                  // 第 2 次：工具输出 18 → 21
        rec(28, 'r3', 3000), tc(28.3, 6000, 3000),                  // 第 3 次：无工具，紧接上一响应 21 → 28
        tc(40, 10000, 4000),                                        // 没有响应记录（旧版 CLI）：不记耗时
      ]));
      await run(store, collectCodexFile, { path: p, fileId: 'rollout-x', offset: 0, state: undefined, version: 6 });
      const rows = store.db.prepare("SELECT duration_ms d FROM events WHERE tool = 'codex' ORDER BY ts").all().map(r => r.d);
      assert.deepEqual(rows, [6000, 3000, 7000, null]);
    });

    await check('noteDuration 只增不减，Codex 键先归一', () => {
      const store = mk();
      store.insertEvent({ ts: 1, tool: 'ccmr', model: 'm', output_tokens: 5, total_tokens: 5, dedup_key: 'k1' });
      store.noteDuration('ccmr', 'k1', 3000);
      store.noteDuration('ccmr', 'k1', 1000);
      assert.equal(duration(store, 'k1'), 3000);
    });

    await check('modelSpeed：中位数 / P90、短输出不计速度、Codex 标近似', () => {
      const rows = [
        ...[1000, 2000, 3000, 4000, 10000].map(d => ({ model: 'opus', tool: 'claude-code', output_tokens: d / 10, duration_ms: d })),
        { model: 'opus', tool: 'claude-code', output_tokens: 3, duration_ms: 500 }, // 输出太短：只算耗时，不算速度
        { model: 'gpt', tool: 'codex', output_tokens: 400, duration_ms: 4000 },
      ];
      const [opus, gpt] = modelSpeed(rows);
      assert.equal(opus.model, 'opus');
      assert.equal(opus.requests, 6);
      assert.equal(opus.median_tps, 100);
      assert.equal(opus.median_ms, 2500);
      assert.equal(opus.p90_ms, 10000);
      assert.equal(opus.approx, false);
      assert.deepEqual([gpt.model, gpt.approx, gpt.median_tps], ['gpt', true, 100]);
    });

    await check('/api/speed 按模型返回、受日期与设备筛选', async () => {
      const { startServer } = await import('../src/server.js');
      const store = mk();
      const now = Date.now();
      const ins = store.db.prepare('INSERT INTO events (ts, tool, model, output_tokens, total_tokens, dedup_key, duration_ms, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      ins.run(now, 'claude-code', 'opus', 500, 500, 'a', 5000, 'local');
      ins.run(now, 'claude-code', 'opus', 500, 500, 'b', 5000, 'windows');
      ins.run(now - 40 * 86400_000, 'claude-code', 'old', 500, 500, 'c', 5000, 'local');
      ins.run(now, 'claude-code', 'nodur', 500, 500, 'd', null, 'local');
      const scanner = new EventEmitter(); scanner.stats = {};
      const poller = { start() {} };
      const server = await startServer({ store, scanner, port: 0, claudePoller: poller, cursorPoller: poller, zcodePoller: poller });
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const all = await (await fetch(`${base}/api/speed?days=7`)).json();
        assert.deepEqual(all.models.map(m => [m.model, m.requests]), [['opus', 2]]);
        const local = await (await fetch(`${base}/api/speed?days=7&device=local`)).json();
        assert.equal(local.models[0].requests, 1);
        assert.equal((await fetch(`${base}/api/speed?device=nope`)).status, 400);
      } finally {
        server.closeAllConnections(); await new Promise(r => server.close(r));
      }
    });
  } finally {
    for (const s of stores) s.close();
    rmSync(root, { recursive: true, force: true });
  }
}
