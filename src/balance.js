import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME } from './config.js';

/**
 * 厂商余额轮询：从 ~/.ccmr/.env 读取 key（不出后端），调各厂商公开余额接口。
 * 只接入有公开接口的厂商；无接口/无 key 的自动跳过。
 */
const PROVIDERS = [
  {
    id: 'deepseek', name: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY',
    url: 'https://api.deepseek.com/user/balance',
    parse: (j) => {
      const cny = j.balance_infos?.find(b => b.currency === 'CNY');
      return cny ? { balance: Number(cny.total_balance) } : null;
    },
  },
  {
    id: 'kimi', name: 'Kimi', envKey: 'KIMI_CN_API_KEY',
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    parse: (j) => {
      const v = j.data?.available_balance ?? j.available_balance;
      return v != null ? { balance: Number(v) } : null;
    },
  },
  {
    id: 'glm', name: 'GLM', envKey: 'GLM_PLAN_API_KEY',
    url: 'https://open.bigmodel.cn/api/paas/v4/users/balance',
    parse: (j) => {
      const v = j.data?.balanceTotal ?? j.data?.balance ?? j.balanceTotal;
      return v != null ? { balance: Number(v) } : null;
    },
  },
];

async function loadEnvFile(path) {
  const map = {};
  try {
    const text = await readFile(path, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(\S+)\s*$/);
      if (m) map[m[1]] = m[2];
    }
  } catch { /* 文件不存在 */ }
  return map;
}

async function fetchJson(url, key, timeoutMs = 10_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

export class BalancePoller {
  constructor(store, { log = () => {}, intervalMs = 30 * 60_000 } = {}) {
    this.store = store;
    this.log = log;
    this.intervalMs = intervalMs;
    this._timer = null;
    this.onChange = null;
  }

  async poll() {
    const env = await loadEnvFile(join(HOME, '.ccmr/.env'));
    let changed = 0;
    for (const p of PROVIDERS) {
      const key = env[p.envKey];
      if (!key) continue;
      try {
        const j = await fetchJson(p.url, key);
        const out = p.parse(j);
        if (!out) throw new Error('unrecognized response');
        this.store.saveQuota(`balance:${p.id}`, Date.now(), { ...out, provider: p.name, currency: 'CNY' });
        changed++;
      } catch (err) {
        this.log(`balance ${p.id}: ${err.message}`);
      }
    }
    if (changed > 0 && this.onChange) this.onChange();
  }

  start() {
    setTimeout(() => this.poll().catch(() => {}), 3000).unref?.();
    this._timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs);
    this._timer.unref?.();
  }

  stop() { if (this._timer) clearInterval(this._timer); }
}
