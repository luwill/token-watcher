import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, isOffline } from './config.js';

/**
 * LiteLLM 实时模型价格：
 * 拉取社区维护的全模型牌价表（model_prices_and_context_window.json，约 2MB / 3900+ 条），
 * 本地缓存 24h；价格单位为每 token 美元。
 * 查找策略：精确键 > 裸名索引（同名多条时优先直连厂商键，其次 azure/vertex，最后 openrouter 等聚合商）。
 */
const PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_PATH = join(DATA_DIR, 'litellm-prices.json');
const TTL_MS = 24 * 3600_000;

// 我们模型名 → LiteLLM 裸名的已知映射（索引按裸名建）
const MANUAL_ALIASES = {
  'grok-4.6-build': 'grok-4.6', // build 变体按同代基模价格估算；精确值可经 pricing.json 覆盖
};

let index = null;        // 裸名/精确键 → 价格条目
let loading = null;
let onChange = null;
export function setOnChange(fn) { onChange = fn; }

function buildIndex(table) {
  const byBare = new Map();
  const rank = (k) => {
    if (!k.includes('/')) return 0;
    if (/^(openrouter|cloudflare|bedrock_mantle|us-gov)/.test(k)) return 3;
    if (/^(azure|vertex_ai|azure_ai|bedrock)/.test(k)) return 2;
    return 1; // xai/ deepseek/ moonshot/ zai/ anthropic/ openai/ 等直连厂商
  };
  for (const [k, v] of Object.entries(table)) {
    if (!v || typeof v !== 'object' || v.input_cost_per_token == null) continue;
    const bare = k.split('/').pop();
    const prev = byBare.get(bare);
    if (!prev || rank(k) < prev.rank) byBare.set(bare, { rank: rank(k), key: k, v });
  }
  const idx = new Map();
  for (const [bare, { key, v }] of byBare) idx.set(bare, v);
  return idx;
}

export async function ensurePrices({ force = false } = {}) {
  if (index && !force) return index;
  if (loading) return loading;
  loading = (async () => {
    try {
      // 离线：只读本地缓存；没有缓存就留空表，未命中的模型走 pricing.json 或列入 unpriced
      if (isOffline()) {
        index = buildIndex(JSON.parse(await readFile(CACHE_PATH, 'utf8')));
        onChange?.();
        return index;
      }
      const fresh = !force && await stat(CACHE_PATH).then(s => Date.now() - s.mtimeMs < TTL_MS).catch(() => false);
      if (!fresh) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 30_000);
        try {
          const res = await fetch(PRICES_URL, { signal: ac.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          await writeFile(CACHE_PATH, text).catch(() => {});
          index = buildIndex(JSON.parse(text));
        } finally { clearTimeout(t); }
      } else {
        index = buildIndex(JSON.parse(await readFile(CACHE_PATH, 'utf8')));
      }
      onChange?.();
    } catch { /* 网络失败：保留缓存/空表，费用列 unpriced */ }
    finally { loading = null; }
    return index;
  })();
  return loading;
}

/** 每百万 token 单价（USD）：{input, cacheRead, cacheWrite, output}；未命中返回 null */
export function lookupPrice(model) {
  if (!index || !model) return null;
  const v = index.get(MANUAL_ALIASES[model] ?? model);
  if (!v) return null;
  return {
    input: (v.input_cost_per_token || 0) * 1e6,
    cacheRead: (v.cache_read_input_token_cost || 0) * 1e6,
    cacheWrite: (v.cache_creation_input_token_cost || 0) * 1e6,
    output: (v.output_cost_per_token || 0) * 1e6,
  };
}
