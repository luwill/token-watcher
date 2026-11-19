import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { aggregateCosts, computeCosts } from '../src/pricing.js';
import { officialPrice } from '../src/officialPricing.js';

export async function testOfficialPricing(ok) {
  const now = Date.UTC(2026, 9, 14, 1);
  const db = new DatabaseSync(':memory:');
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
  try {
    db.exec('CREATE TABLE events (ts INTEGER, tool TEXT, model TEXT, input_tokens INTEGER, cached_input INTEGER, cache_write INTEGER, output_tokens INTEGER)');
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)');
    const add = (tool, model, fi = 1e6, ci = 1e6, cw = 1e6, oi = 1e6) => insert.run(now, tool, model, fi, ci, cw, oi);
    // 独立预期值含缓存读/写；USD × 2，CNY 不乘汇率。工具合计不等于单次长上下文。
    const cases = [
      ['antigravity', 'gemini-3.8-flash-n', 9.15],
      ['ccmr', 'step-5-preview', 27.7],
      ['ccmr', 'qwen4-max', 53], // CNY 10 + 0.5 + 12.5（5min 缓存写）+ 30，不乘汇率
      ['cursor', 'claude-opus-5-5-max', 70.08],
      ['cursor', 'grok-4.7-high-fast', 34],
      ['grok', 'grok-4.7-build', 17],
      ['kimi', 'k3', 142],
      ['workbuddy', 'kimi-k3-1', 142],
      ['workbuddy', 'hy4-preview-f', 24.3],
      ['opencode', 'mimo-v2.5-free', 0],
      ['opencode', 'stealth/union-alpha', 0],
      ['pi', 'deepseek/deepseek-v4-flash-0731', 1.344],
    ];
    for (const [tool, model, expected] of cases) {
      db.exec('DELETE FROM events');
      add(tool, model);
      const result = aggregateCosts(db, 0, { rate: 2, now });
      near(result.cny, expected);
      assert.deepEqual(result.unpriced, []);
      assert.equal(result.by_model[0].tokens, 4e6);
      ok(`官方价格及来源别名：${model}（含缓存写、币种）`, true);
    }

    db.exec('DELETE FROM events');
    add('antigravity', 'gemini-3.8-flash-n', 1e6, 1e6, 0, 1e6);
    near(aggregateCosts(db, 0, { rate: 1, now: Date.UTC(2026, 11, 31, 23, 59, 59) }).cny, 4.575);
    near(aggregateCosts(db, 0, { rate: 1, now: Date.UTC(2027, 0, 1) }).cny, 9.15);
    ok('Gemini 3.8 Flash 优惠截止时刻与下一档官方价', true);
    const table = {
      'gemini-3.8-flash': { currency: 'CNY', input_miss: 1, input_hit: 2, output: 3 },
      'gemini-3.8-flash-n': { currency: 'CNY', input_miss: 5, input_hit: 6, output: 7 },
    };
    near(aggregateCosts(db, 0, { rate: 8, table, now }).cny, 18);
    delete table['gemini-3.8-flash-n'];
    near(aggregateCosts(db, 0, { rate: 8, table, now }).cny, 6);
    ok('原始别名用户价优先，规范模型用户价次之，官方价最后回退', true);

    db.exec('DELETE FROM events');
    add('kimi', 'k3');
    const k3 = { currency: 'CNY', input_miss: 1, input_hit: 2, output: 3 };
    near(aggregateCosts(db, 0, { rate: 8, table: { 'kimi-k3': k3 }, now }).cny, 26);
    near(aggregateCosts(db, 0, { rate: 8, table: { 'kimi-k3': { ...k3, input_write: 0 } }, now }).cny, 6);
    ok('旧三项 K3 用户表补官方默认缓存写价，显式零价保留', true);

    db.exec('DELETE FROM events');
    add('claude-code', 'claude-opus-5-5', 0, 0, 1e6, 0);
    near(aggregateCosts(db, 0, { rate: 2, now }).cny, 10);
    near(aggregateCosts(db, 0, { rate: 2, table: { 'claude-opus-5-5': { currency: 'USD', input_miss: 4, input_hit: .2, output: 20 } }, now }).cny, 10);
    ok('只有缓存写的事件仍计费，旧 Opus 三项价不漏写缓存费', true);

    db.exec('DELETE FROM events');
    add('pi', 'grok-4.7', 100000, 99999, 0, 1000); // 单次未满 200k
    add('pi', 'grok-4.7', 100000, 100000, 0, 1000); // 等于 200k 进入长上下文
    near(aggregateCosts(db, 0, { rate: 1, now }).cny, .7679995);
    assert.deepEqual(officialPrice('grok-4.7-fast', { tool: 'cursor', longContext: true }).input_miss, 6);
    ok('Grok 单次请求按含缓存输入的 200k 边界分档，Fast 长上下文按 1.5 倍', true);
    db.exec('DELETE FROM events');
    add('cursor', 'grok-4.7-high-fast', 50e6, 50e6, 0, 1e6);
    add('grok', 'grok-4.7-build', 50e6, 50e6, 0, 1e6);
    near(aggregateCosts(db, 0, { rate: 1, now }).cny, 262 + 131);
    ok('Cursor/Grok 多调用汇总不误当成单次长上下文加价', true);
    assert.equal(officialPrice('step-5-preview', { now: Date.UTC(2026, 9, 13, 16, 29, 59) }).input_hit, .35);
    assert.equal(officialPrice('step-5-preview', { now: Date.UTC(2026, 9, 13, 16, 30) }).input_hit, .7);
    ok('Step 5 缓存价格切换时刻；旧账户资格不从日志臆测', true);

    db.exec('DELETE FROM events');
    const guarded = ['gemini-3.8-flash-n', 'k3', 'kimi-k3-1', 'hy4-preview-f', 'grok-4.7-build', 'claude-opus-5-5-max', 'grok-4.7-high-fast', 'mimo-v2.5-free', 'stealth/union-alpha'];
    for (const model of guarded) {
      assert.equal(officialPrice(model, { tool: 'unverified-tool', now }), null);
      add('unverified-tool', model);
    }
    const unknown = ['water18-0910', 'codex-auto-review', 'auto', 'grok-bot-automation', 'grok-bot-cua', 'grok-bot-default'];
    for (const model of unknown) add('unverified-tool', model);
    const gaps = aggregateCosts(db, 0, { rate: 2, now });
    assert.equal(gaps.cny, 0);
    assert.deepEqual(new Set(gaps.unpriced), new Set([...guarded, ...unknown]));
    ok('别名/免费价严格限定来源；自动路由与未知模型继续明确缺价', true);

    db.exec('DELETE FROM events');
    for (const [tool, model] of cases) add(tool, model);
    add('unverified-tool', 'gemini-3.8-flash-n');
    const chart = await computeCosts(db, 30, { now });
    const day = chart.by_day.find(d => d.models['gemini-3.8-flash-n'] > 0);
    assert.ok(day);
    near(day.models['gemini-3.8-flash-n'], 4.575 * chart.usd_to_cny);
    near(chart.by_day.reduce((sum, d) => sum + d.total, 0), chart.today_cny);
    near(chart.today_cny, chart.all_cny);
    assert.ok(chart.unpriced.includes('gemini-3.8-flash-n')); // 只有未知工具下的同名事件缺价
    assert.equal(day.models['mimo-v2.5-free'], 0);
    assert.ok(!chart.unpriced.includes('mimo-v2.5-free'));
    ok('按天图/费用卡/总费用一致；同名不同来源不混价，免费不冒充缺价', true);
  } finally { db.close(); }
}
