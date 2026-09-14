import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

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
    'deepseek-flash':   { currency: 'USD', input_miss: 0.30,  input_hit: 0.006, output: 1.20 },
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
 * 计算 ccmr 侧费用。窗口：0=全部；否则最近 N 天。
 * 返回 { today_cny, last7d_cny, all_cny, by_model, unpriced }
 */
export async function computeCosts(db) {
  const pricing = await loadPricing();
  const rate = pricing.usd_to_cny || 7.2;
  const table = pricing.models || {};
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const win = (since, label) => db.prepare(`
    SELECT model, SUM(input_tokens) fi, SUM(cached_input) ci, SUM(output_tokens) oi
    FROM events WHERE tool = 'ccmr' AND ts >= ? GROUP BY model`).all(since);

  const agg = (rows) => {
    let cny = 0;
    const byModel = [];
    const unpriced = [];
    for (const m of rows) {
      const p = table[m.model];
      if (!p) { if (m.fi + m.ci + m.oi > 0) unpriced.push(m.model); continue; }
      const c = toCny(modelCostCny(p, m), p.currency, rate);
      cny += c;
      byModel.push({ model: m.model, cost_cny: c, tokens: (m.fi || 0) + (m.ci || 0) + (m.oi || 0), usd: p.currency === 'USD' });
    }
    byModel.sort((a, b) => b.cost_cny - a.cost_cny);
    return { cny, byModel, unpriced: [...new Set(unpriced)] };
  };

  const all = agg(win(0));
  const today = agg(win(dayStart.getTime()));
  const last7 = agg(win(Date.now() - 7 * 86_400_000));
  return {
    today_cny: today.cny,
    last7d_cny: last7.cny,
    all_cny: all.cny,
    by_model: all.byModel,
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
