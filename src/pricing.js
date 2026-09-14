import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { ensurePrices, lookupPrice } from './litellm.js';

/**
 * ccmr 费用折算：单价表 ~/.token-stats/pricing.json（用户可编辑覆盖）。
 * 种子值来源（2026-09-13 抓取官方定价页）：
 *   DeepSeek api-docs.deepseek.com/quick_start/pricing（美元，峰时价，谷时为其一半）
 *   Kimi platform.kimi.com/docs/pricing/chat（人民币）
 * 未配置单价的模型不计费，仅列入 unpriced。
 */
const PRICING_PATH = join(DATA_DIR, 'pricing.json');

const SEED = {
  usd_to_cny: 7.2,
  _note: '单价为每百万 token；DeepSeek 为峰时价（谷时减半）；编辑后即时生效',
  models: {
    'deepseek-v4.1-flash': { currency: 'USD', input_miss: 0.30, input_hit: 0.006, output: 1.20 },
    'deepseek-v4-flash': { currency: 'USD', input_miss: 0.30, input_hit: 0.006, output: 1.20 }, // 官方已路由至 V4.1 Flash 同价
    'deepseek-v4-pro':  { currency: 'USD', input_miss: 1.32,  input_hit: 0.044, output: 3.96 },
    'kimi-k2.6':        { currency: 'CNY', input_miss: 6.50,  input_hit: 1.10,  output: 27.0 },
    'kimi-k2.7-code':   { currency: 'CNY', input_miss: 6.50,  input_hit: 1.30,  output: 27.0 },
    'kimi-k3':          { currency: 'CNY', input_miss: 20.0,  input_hit: 2.00,  output: 100.0 },
  },
};

let cached = null;

export async function loadPricing() {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(PRICING_PATH, 'utf8'));
  } catch {
    await writeFile(PRICING_PATH, JSON.stringify(SEED, null, 2) + '\n', { mode: 0o600 }).catch(() => {});
    cached = SEED;
  }
  return cached;
}

function modelCostCny(p, m) {
  return (m.fi / 1e6) * p.input_miss + (m.ci / 1e6) * p.input_hit + (m.oi / 1e6) * p.output;
}

/** 归一化到人民币（USD 按 usd_to_cny 折算，折算标志返回） */
function toCny(amount, currency, rate) {
  return currency === 'USD' ? amount * rate : amount;
}

/**
 * 全源费用折算（7 源）：
 * 单价解析优先级 = 用户 pricing.json（可含人民币直价）> LiteLLM 实时牌价（USD×汇率）。
 * ccmr 为按量实付；claude-code/codex/zcode/grok-build 等订阅制工具为 "API 等值成本"（假设性），
 * 前端需分开标注。窗口：0=全部。
 */
function priceOf(model, table, rate) {
  const local = table[model];
  if (local) {
    return {
      inCny: local.currency === 'USD' ? local.input_miss * rate : local.input_miss,
      cacheCny: local.currency === 'USD' ? local.input_hit * rate : local.input_hit,
      outCny: local.currency === 'USD' ? local.output * rate : local.output,
      cacheWCny: 0,
    };
  }
  const p = lookupPrice(model);
  if (!p) return null;
  return { inCny: p.input * rate, cacheCny: p.cacheRead * rate, outCny: p.output * rate, cacheWCny: p.cacheWrite * rate };
}

export async function computeCosts(db, days = 30) {
  const pricing = await loadPricing();
  const rate = pricing.usd_to_cny || 7.2;
  const table = pricing.models || {};
  await Promise.race([ensurePrices().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);

  const agg = (since) => {
    const rows = db.prepare(`
      SELECT tool, model, SUM(input_tokens) fi, SUM(cached_input) ci,
             SUM(cache_write) cw, SUM(output_tokens) oi
      FROM events WHERE ts >= ? GROUP BY tool, model`).all(since);
    const byModel = new Map(), byTool = new Map(), unpriced = new Set();
    let total = 0;
    for (const r of rows) {
      const tokens = (r.fi || 0) + (r.ci || 0) + (r.oi || 0);
      if (tokens <= 0) continue;
      const p = priceOf(r.model, table, rate);
      if (!p) { unpriced.add(r.model); continue; }
      const c = (r.fi / 1e6) * p.inCny + (r.ci / 1e6) * p.cacheCny
        + (r.cw / 1e6) * p.cacheWCny + (r.oi / 1e6) * p.outCny;
      total += c;
      const m = byModel.get(r.model) || { model: r.model, cost_cny: 0, tokens: 0 };
      m.cost_cny += c; m.tokens += tokens; byModel.set(r.model, m);
      const t = byTool.get(r.tool) || { tool: r.tool, cost_cny: 0 };
      t.cost_cny += c; byTool.set(r.tool, t);
    }
    return {
      cny: total,
      by_model: [...byModel.values()].sort((a, b) => b.cost_cny - a.cost_cny),
      by_tool: [...byTool.values()].sort((a, b) => b.cost_cny - a.cost_cny),
      unpriced: [...unpriced],
    };
  };

  const all = agg(0);
  const today = agg(dayStart.getTime());
  const last7 = agg(Date.now() - 7 * 86_400_000);

  // 按天 × 模型成本（供"按天花费"堆叠柱形图）
  const rangeStart = days > 0 ? dayStart.getTime() - (days - 1) * 86_400_000 : 0;
  const dayRows = db.prepare(`
    SELECT date(ts/1000, 'unixepoch', 'localtime') d, model,
           SUM(input_tokens) fi, SUM(cached_input) ci, SUM(cache_write) cw, SUM(output_tokens) oi
    FROM events WHERE ts >= ? GROUP BY d, model ORDER BY d`).all(rangeStart);
  const byDayMap = new Map();
  for (const r of dayRows) {
    const p = priceOf(r.model, table, rate);
    if (!p) continue;
    const c = (r.fi / 1e6) * p.inCny + (r.ci / 1e6) * p.cacheCny
      + (r.cw / 1e6) * p.cacheWCny + (r.oi / 1e6) * p.outCny;
    if (!byDayMap.has(r.d)) byDayMap.set(r.d, { day: r.d, models: {}, total: 0 });
    const e = byDayMap.get(r.d);
    e.models[r.model] = (e.models[r.model] || 0) + c;
    e.total += c;
  }
  return {
    by_day: [...byDayMap.values()],
    today_cny: today.cny,
    last7d_cny: last7.cny,
    all_cny: all.cny,
    by_model: all.by_model,
    by_tool: all.by_tool,
    today_by_tool: today.by_tool,
    unpriced: all.unpriced,
    usd_to_cny: rate,
  };
}

/** 余额对账：最近 hours 小时余额差值 vs 统计口径花费（仅人民币计价厂商） */
export function computeRecon(db, store, pricing, hours = 24) {
  const since = Date.now() - hours * 3_600_000;
  const table = pricing?.models || {};
  const PROVIDER_PREFIX = { deepseek: 'deepseek', kimi: 'kimi' };
  const out = [];
  for (const b of store.getBalances()) {
    const rows = db.prepare(
      'SELECT ts, balance FROM balance_history WHERE provider = ? AND ts >= ? ORDER BY ts').all(b.id, since);
    if (rows.length < 2) { out.push({ provider: b.provider, id: b.id, balance: b.balance, delta: null, spend: null, hours }); continue; }
    const delta = rows[rows.length - 1].balance - rows[0].balance;
    const prefix = PROVIDER_PREFIX[b.id];
    let spend = null;
    if (prefix) {
      spend = 0;
      for (const m of db.prepare(`
        SELECT model, SUM(input_tokens) fi, SUM(cached_input) ci, SUM(output_tokens) oi
        FROM events WHERE tool = 'ccmr' AND ts >= ? GROUP BY model`).all(since)) {
        const p = table[m.model];
        if (!p || !m.model.startsWith(prefix) || p.currency !== 'CNY') continue;
        spend += (m.fi / 1e6) * p.input_miss + (m.ci / 1e6) * p.input_hit + (m.oi / 1e6) * p.output;
      }
    }
    out.push({ provider: b.provider, id: b.id, balance: b.balance, delta, spend, hours });
  }
  return out;
}
