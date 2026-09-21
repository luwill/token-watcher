import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, SOURCES } from './config.js';
import { loadPricing, aggregateCosts } from './pricing.js';
import { ensurePrices } from './litellm.js';
import { ensureFxRate } from './fx.js';

/**
 * 订阅 ROI：本月"API 等值成本" vs "订阅实付"。
 *
 * 配置 ~/.tokenmeter/subscriptions.json（用户手填，不猜价）：
 *   { "monthly": { "claude-code": { "name": "Claude Max", "price_usd": 200 },
 *                  "kimi":        { "name": "Kimi 会员",  "price_cny": 49 } } }
 * 键为工具 id（注册表 tool 名）；price_cny / price_usd 二选一。
 *
 * - API 等值走与费用卡同一条链路（pricing.json > LiteLLM×汇率 + 峰谷），按本地自然月聚合；
 * - 积分制工具（Qoder 等 credit_usage 有账的）：本地不报 token、无牌价可折——如实显示
 *   本月积分消耗，不硬造"API 等值"比值（ratio = null）；
 * - 未配置时不显示 ROI，但若订阅制工具本月已有花费，返回 hint 供前端引导配置；
 * - 比值 ≥1 表示"按 API 价折算，订阅是划算的"；注意这是假设性口径（订阅有速率限制、
 *   API 有折扣价，两者并非等价物），前端标注清楚。
 */
const SUBS_PATH = join(DATA_DIR, 'subscriptions.json');

export async function loadSubscriptions(path = SUBS_PATH) {
  try {
    const j = JSON.parse(await readFile(path, 'utf8'));
    return j && typeof j.monthly === 'object' ? j : null;
  } catch { return null; } // 未配置是正常态
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4; // 小额 API 等值（月费零头的订阅早期）r2 会抹成 0

export async function computeRoi(db, { rate = null } = {}) {
  const subs = await loadSubscriptions();
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const from = monthStart.getTime();

  if (rate == null) {
    const pricing = await loadPricing();
    const fx = await Promise.race([
      ensureFxRate(pricing),
      new Promise(r => setTimeout(() => r({ rate: pricing.usd_to_cny || 7.2, source: 'default' }), 2500)),
    ]);
    rate = fx.rate;
  }

  // LiteLLM 索引必须先就位（serve 里由费用卡顺带加载，CLI 单跑 roi 时没人调过——
  // 不加载则订阅工具的非 pricing.json 模型全部按"未配价"漏算，ROI 严重偏低）
  await Promise.race([ensurePrices().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
  const month = aggregateCosts(db, from, { rate, table: (await loadPricing()).models || {} });
  const byTool = new Map(month.by_tool.map(t => [t.tool, t.cost_cny]));
  const creditsByTool = new Map();
  for (const r of db.prepare(
    'SELECT tool, SUM(amount) t FROM credit_usage WHERE ts >= ? GROUP BY tool').all(from)) {
    creditsByTool.set(r.tool, r.t);
  }

  if (!subs || !Object.keys(subs.monthly).length) {
    // 引导态：订阅制工具本月已有花费但未配置月费
    const subTools = SOURCES.filter(s => s.subscription).map(s => s.tool);
    const spend = month.by_tool.filter(t => subTools.includes(t.tool)).reduce((a, t) => a + t.cost_cny, 0);
    return { configured: false, month_start: from, usd_to_cny: rate,
      hint: spend > 0 ? { sub_tools_api_cny: r2(spend) } : null, entries: [] };
  }

  const entries = [];
  for (const [key, cfg] of Object.entries(subs.monthly)) {
    if (!cfg || typeof cfg === 'string') continue; // _note 等说明字段
    // 工具取条目内的 tool 字段（同一工具可有多条订阅，如 zcode 的 GLM 与 MiniMax），
    // 未填时回落外层键（老格式：键即工具 id）
    const tool = typeof cfg.tool === 'string' && cfg.tool ? cfg.tool : key;
    const src = SOURCES.find(s => s.tool === tool);
    // models 过滤（可选）："一个工具、多个套餐"的场景——GLM 与 MiniMax 的用量都落在
    // zcode 下，用模型前缀把两份订阅分开；无过滤则按整工具聚合
    const prefix = typeof cfg.models === 'string' && cfg.models ? cfg.models.toLowerCase() : null;
    let api = 0;
    if (prefix) {
      for (const g of month.by_tool_model) {
        if (g.tool === tool && (g.model || '').toLowerCase().startsWith(prefix)) api += g.cost_cny;
      }
    } else {
      api = byTool.get(tool) ?? 0;
    }
    const credits = prefix ? null : (creditsByTool.get(tool) ?? null);
    // 月费未填：条目仍显示（api 等值 + "月费未填"），不吞掉——填上价 ROI 即出
    const paid = cfg.price_cny ?? (cfg.price_usd != null ? cfg.price_usd * rate : null);
    entries.push({
      tool,
      models: prefix,
      name: cfg.name || src?.label || tool,
      api_cny: r4(api),          // 本月 API 等值（无牌价可折时为 0）
      credits,                   // 本月积分消耗（积分制工具且未用模型过滤时）
      paid_cny: paid == null ? null : r2(paid),
      // 比值只在有月费、token 计价且非积分制时有意义
      ratio: paid == null || credits != null ? null : (api > 0 ? api / paid : 0),
    });
  }
  entries.sort((a, b) => (b.api_cny + (b.credits ?? 0)) - (a.api_cny + (a.credits ?? 0)));
  // 文件在但没有任何条目（键都不合法）：回落引导态（显示 hint），不沉默
  if (!entries.length) {
    const subTools = SOURCES.filter(x => x.subscription).map(x => x.tool);
    const spend = month.by_tool.filter(t => subTools.includes(t.tool)).reduce((a, t) => a + t.cost_cny, 0);
    return { configured: false, month_start: from, usd_to_cny: rate,
      hint: spend > 0 ? { sub_tools_api_cny: r2(spend) } : null, entries: [] };
  }
  return { configured: true, month_start: from, usd_to_cny: rate, entries };
}
