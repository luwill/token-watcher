/**
 * Codex 单次用量与重放识别。
 *
 * 子代理 / 分叉 / 审查代理的 rollout 在创建那一刻把父会话历史整段写进文件开头：
 * 每行都盖上同一瞬间的时间戳（实测段内相邻行 ≤53ms），内容是父会话已经计过的请求。
 * 真实请求要等模型返回，离会话创建最少也有 2 秒（698 个真实 rollout 实测最小 2135ms）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { collectCodexFile } from '../src/collectors/codex.js';

const T0 = Date.parse('2026-08-11T13:02:58.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
// OpenAI 口径：input 已含 cached，total = input + output
const use = (input, cached, output) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
  output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
});
const sum = (...us) => us.reduce((a, b) => Object.fromEntries(Object.keys(a).map(k => [k, a[k] + b[k]])));

const meta = (ms, extra = {}) => JSON.stringify({ timestamp: iso(ms), type: 'session_meta',
  payload: { id: 'child', cwd: '/work/projR', ...extra } });
const tok = (ms, total, last, rate_limits) => JSON.stringify({ timestamp: iso(ms), type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}) },
    ...(rate_limits ? { rate_limits } : {}) } });
const call = (ms, id) => JSON.stringify({ timestamp: iso(ms), type: 'response_item',
  payload: { type: 'function_call', name: 'shell', call_id: id } });

const record = (ms, usage, responseId) => JSON.stringify({ timestamp: iso(ms), type: 'token_usage_record',
  payload: { response_id: responseId, usage } });
const compacted = (ms) => JSON.stringify({ timestamp: iso(ms), type: 'compacted', payload: { message: '' } });

const SUBAGENT = { parent_thread_id: 'parent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } };

export async function testCodexReplay(ok) {
  console.log('\n[codex] 单次用量与重放识别');
  const root = mkdtempSync(join(tmpdir(), 'tw-codex-'));
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); }
    catch (err) { ok(name, false, err.stack); }
  };
  let n = 0;
  /** 每个用例独立的库与 rollout 文件；返回采集结果与查询助手 */
  const scan = async (lines, { seed } = {}) => {
    const dir = mkdtempSync(join(root, `c${n++}-`));
    const stem = 'rollout-2026-08-11T21-02-58-child';
    const path = join(dir, `${stem}.jsonl`);
    writeFileSync(path, lines.map(l => l + '\n').join(''));
    const store = new Store(join(dir, 'x.db'));
    seed?.(store, stem);
    const r = await collectCodexFile(store, { path, fileId: stem, offset: 0, state: undefined, version: 4 });
    const events = store.db.prepare(
      "SELECT ts, total_tokens t, input_tokens i, cached_input c, output_tokens o FROM events WHERE tool = 'codex' ORDER BY ts").all();
    const calls = store.db.prepare("SELECT dedup_key k FROM tool_calls WHERE tool = 'codex' ORDER BY ts").all().map(c => c.k);
    return { store, path, stem, r, events, calls, total: events.reduce((s, e) => s + e.t, 0) };
  };

  try {
    const A = use(30_000, 0, 400), B = use(40_000, 28_000, 700), C = use(52_000, 39_000, 300);
    const D = use(61_000, 50_000, 900), E = use(70_000, 60_000, 500);

    await check('子代理文件开头重放的父会话历史不计入，之后的真实请求照常计入', async () => {
      const { events, calls, total, store } = await scan([
        meta(0, SUBAGENT),
        tok(1, A, A), call(1, 'parent-call'),
        tok(2, sum(A, B), B),
        tok(3, sum(A, B, C), C),
        call(7_000, 'child-call'),
        tok(8_000, sum(A, B, C, D), D),
        tok(20_000, sum(A, B, C, D, E), E),
      ]);
      assert.equal(events.length, 2, JSON.stringify(events));
      assert.equal(total, D.total_tokens + E.total_tokens);
      assert.deepEqual(events.map(e => e.ts), [T0 + 8_000, T0 + 20_000]);
      assert.deepEqual(calls.map(k => k.split(':').pop()), ['child-call']);
      store.close();
    });

    await check('重放行里的配额快照是父会话的旧数据，不覆盖当前配额', async () => {
      const limits = (used) => ({ limit_id: 'codex', primary: { used_percent: used, window_minutes: 10080, resets_at: 1799999999 }, secondary: null, plan_type: 'pro' });
      const { store } = await scan([
        meta(0, SUBAGENT),
        tok(1, A, A, limits(10)),           // 父会话很早以前的快照，被重放时盖上了分叉时刻
        tok(8_000, sum(A, D), D),
      ], { seed: (st) => st.saveQuota('codex', T0 - 60_000, { plan_type: 'pro', windows: [{ window_minutes: 10080, used_percent: 80, resets_at: 1799999999 }] }) });
      assert.equal(store.getQuota('codex').data.windows[0].used_percent, 80);
      store.close();
    });

    await check('全新会话的第一次请求计入（累计值等于本次用量，不是继承来的历史）', async () => {
      const { events, total, store } = await scan([
        meta(0),
        tok(3_000, A, A),
        tok(9_000, sum(A, B), B),
      ]);
      assert.equal(events.length, 2, JSON.stringify(events));
      assert.equal(total, A.total_tokens + B.total_tokens);
      // 新输入 = input - 缓存命中
      assert.deepEqual(events.map(e => [e.i, e.c, e.o]), [[30_000, 0, 400], [12_000, 28_000, 700]]);
      store.close();
    });

    await check('累计值不变的重复通知不产生用量；会话恢复后计数器归零的那次请求计入', async () => {
      const { events, total, store } = await scan([
        meta(0),
        tok(3_000, A, A),
        tok(9_000, sum(A, B), B),
        tok(9_500, sum(A, B), B),              // 配额刷新带来的重复通知
        tok(3_600_000, C, C),                  // 隔了一小时恢复：累计从零重新开始
        tok(3_606_000, sum(C, D), D),
      ]);
      assert.equal(events.length, 4, JSON.stringify(events));
      assert.equal(total, A.total_tokens + B.total_tokens + C.total_tokens + D.total_tokens);
      store.close();
    });

    await check('同一文件里交错的两条累计流各算各的（主代理 + 内嵌审查代理）', async () => {
      const R = use(9_000, 0, 120);
      const { events, total, store } = await scan([
        meta(0),
        tok(3_000, A, A),
        tok(9_000, sum(A, B), B),
        tok(12_000, R, R),                     // 审查代理有自己的累计值
        tok(18_000, sum(A, B, C), C),          // 回到主代理：累计值接的是 A+B，不是 R
        tok(18_400, R, R),                     // 审查代理那条的重复通知
        tok(24_000, sum(A, B, C, D), D),
      ]);
      assert.equal(events.length, 5, JSON.stringify(events));
      assert.equal(total, [A, B, R, C, D].reduce((s, x) => s + x.total_tokens, 0));
      store.close();
    });

    await check('重扫时整文件替换旧算法留下的行，别的文件不受影响', async () => {
      const old = (store, key, total) => store.insertEvent({ ts: T0 + 2, tool: 'codex', model: 'gpt-test',
        input_tokens: total - 10, output_tokens: 10, total_tokens: total, dedup_key: key });
      const { events, calls, total, store } = await scan([
        meta(0, SUBAGENT),
        tok(1, A, A), call(1, 'parent-call'),
        tok(2, sum(A, B), B),
        tok(3, sum(A, B, C), C),
        call(7_000, 'child-call'),
        tok(8_000, sum(A, B, C, D), D),
        tok(20_000, sum(A, B, C, D, E), E),
      ], { seed: (st, stem) => {
        // 旧算法：首条当基线，其余逐条差分——重放的 B、C 被算成了请求，序号排到 4
        [B, C, D, E].forEach((x, i) => old(st, `codex:file:${stem}:${i + 1}`, x.total_tokens));
        st.insertToolCall({ ts: T0 + 1, tool: 'codex', name: 'shell', session_id: stem, dedup_key: `codex:tc:file:${stem}:parent-call` });
        old(st, 'codex:file:rollout-2026-08-11T21-02-58-child-sibling:1', 777); // 文件名只是前缀相同
        old(st, 'codex:file:rollout-other:1', 555);
        st.insertToolCall({ ts: T0, tool: 'codex', name: 'shell', session_id: 'o', dedup_key: 'codex:tc:file:rollout-other:keep' });
      } });
      const mine = events.filter(e => e.ts >= T0 + 8_000);
      assert.equal(mine.length, 2, JSON.stringify(events));
      assert.equal(total, D.total_tokens + E.total_tokens + 777 + 555);
      assert.deepEqual(calls.map(k => k.split(':').pop()).sort(), ['child-call', 'keep']);
      store.close();
    });

    await check('同名的旧副本后出现时，不冲掉原文件已采集的请求', async () => {
      const full = [meta(0), tok(3_000, A, A), tok(9_000, sum(A, B), B), tok(15_000, sum(A, B, C), C)];
      const { store, path, stem, r } = await scan(full);
      // 扫描器在采集成功后登记游标；这里照它的做法登记原文件
      store.saveFile({ path, tool: 'codex', session_id: stem, size: 1, mtime_ms: 1, offset: r.newOffset, state_json: JSON.stringify(r.state) });
      const copyDir = join(path, '..', 'archived'); mkdirSync(copyDir);
      const copy = join(copyDir, `${stem}.jsonl`);
      writeFileSync(copy, full.slice(0, 2).map(l => l + '\n').join('')); // 只抄到第一次请求
      await collectCodexFile(store, { path: copy, fileId: stem, offset: 0, state: undefined, version: 4 });
      const rows = store.db.prepare("SELECT total_tokens t FROM events WHERE tool = 'codex' ORDER BY ts").all();
      assert.deepEqual(rows.map(x => x.t), [A, B, C].map(x => x.total_tokens));
      store.close();
    });

    await check('上下文压缩是一次真实请求：累计值不动，用量只记在紧跟 compacted 的记录里', async () => {
      const X = use(237_798, 0, 4_014);        // 压缩调用本身
      const ctx = use(22_000, 0, 415);         // 压缩后回报的上下文大小，不是一次请求
      const { events, total, store } = await scan([
        meta(0),
        record(2_990, A, 'resp_a'), tok(3_000, A, A),
        record(8_990, B, 'resp_b'), tok(9_000, sum(A, B), B),
        record(200_000, X, 'resp_compact'), compacted(200_012), tok(200_016, sum(A, B), ctx),
        record(204_000, C, 'resp_c'), tok(204_005, sum(A, B, C), C),
      ]);
      assert.equal(events.length, 4, JSON.stringify(events));
      assert.equal(total, [A, B, X, C].reduce((s, x) => s + x.total_tokens, 0));
      assert.equal(events.find(e => e.ts === T0 + 200_000)?.t, X.total_tokens);
      store.close();
    });

    await check('子代理文件重放的压缩记录不重复计入', async () => {
      const X = use(237_798, 0, 4_014);
      const { events, total, store } = await scan([
        meta(0, SUBAGENT),
        tok(1, A, A),
        record(2, X, 'resp_compact'), compacted(2), tok(3, A, use(22_000, 0, 415)),
        tok(8_000, sum(A, D), D),
      ], { seed: (st) => st.insertEvent({ ts: T0 - 500_000, tool: 'codex', model: 'gpt-test',
        input_tokens: 237_798, output_tokens: 4_014, total_tokens: X.total_tokens, dedup_key: 'codex:resp:resp_compact' }) });
      assert.equal(events.length, 2, JSON.stringify(events));   // 父文件里那次压缩 + 子代理自己的一次请求
      assert.equal(total, X.total_tokens + D.total_tokens);
      assert.deepEqual(events.map(e => e.ts), [T0 - 500_000, T0 + 8_000]);
      store.close();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
