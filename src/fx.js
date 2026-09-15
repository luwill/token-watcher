import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * USD→CNY 实时汇率：
 * 免费公开接口（无需 key）轮询，每日刷新；本地缓存最后已知值，断网/接口失败时兜底使用。
 * pricing.json 里的 usd_to_cny 若为正数则视为手动覆盖，跳过拉取。
 */
const FX_URLS = [
  'https://open.er-api.com/v6/latest/USD',       // ER-API（免费无 key）
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', // currency-api CDN
];
const CACHE = join(DATA_DIR, 'fx-cache.json');
const TTL_MS = 12 * 3600_000;
const FALLBACK = 7.2; // 拉取失败时的最后兜底（历史中位）

let cached = { rate: FALLBACK, ts: 0, source: 'default' };
let loading = null;
let lastFetch = 0;
let onChange = null;
export function setOnChange(fn) { onChange = fn; }

async function readCache() {
  try {
    const j = JSON.parse(await readFile(CACHE, 'utf8'));
    if (typeof j.rate === 'number' && j.rate >= RATE_MIN && j.rate <= RATE_MAX) return j;
  } catch { /* 无缓存 */ }
  return null;
}

async function writeCache() {
  writeFile(CACHE, JSON.stringify(cached)).catch(() => {});
}

async function fetchOnce(url, timeoutMs = 10_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    // er-api: { rates: { CNY } }；currency-api: { usd: { cny } }
    const rate = j?.rates?.CNY ?? j?.usd?.cny;
    if (typeof rate !== 'number' || rate < RATE_MIN || rate > RATE_MAX) throw new Error('rate out of range');
    return rate;
  } finally { clearTimeout(t); }
}

// 合理区间：USD/CNY 历史波幅远小于此；超出视为接口脏数据
const RATE_MIN = 5.5, RATE_MAX = 9.5;

export async function ensureFxRate(overrides = {}) {
  const manual = Number(overrides.usd_to_cny);
  if (manual > 0 && overrides.usd_to_cny_manual === true) {
    return { ...cached, rate: manual, source: 'manual' };
  }
  if (loading) return loading;
  const stale = Date.now() - cached.ts > TTL_MS;
  const empty = cached.source === 'default';
  if (!empty && !stale && Date.now() - lastFetch < 60_000) return cached;
  loading = (async () => {
    lastFetch = Date.now();
    // 内存缓存新鲜 → 直接用
    const disk = await readCache();
    if (disk && disk.ts > cached.ts) cached = disk;
    if (!empty && !stale && Date.now() - cached.ts < TTL_MS) { loading = null; return cached; }
    // 需要网络
    const fresh = !disk || Date.now() - disk.ts > TTL_MS;
    if (!fresh) { cached = disk; loading = null; return cached; }
    for (const url of FX_URLS) {
      try {
        const rate = await fetchOnce(url);
        cached = { rate: +rate.toFixed(4), ts: Date.now(), source: new URL(url).host };
        await writeCache();
        onChange?.();
        break;
      } catch { /* 下一个源 */ }
    }
    loading = null;
    return cached;
  })();
  return loading;
}
