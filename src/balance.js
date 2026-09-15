import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME, isOffline } from './config.js';

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

async function fetchJson(url, key, timeoutMs = 10_000, fetchImpl = fetch) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: ac.signal });
    // status 带上去：4xx 说明端点/密钥不对，重试无意义，交给熔断器停用
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return await res.json();
  } finally { clearTimeout(t); }
}

export class BalancePoller {
  constructor(store, {
    log = () => {}, intervalMs = 30 * 60_000,
    fetchImpl = undefined, envPath = join(HOME, '.ccmr/.env'), maxClientErrors = 3,
  } = {}) {
    this.store = store;
    this.log = log;
    this.intervalMs = intervalMs;
    this.envPath = envPath;
    this.fetchImpl = fetchImpl;
    this.maxClientErrors = maxClientErrors;
    this._timer = null;
    this.onChange = null;
    this._clientErrors = new Map(); // id -> 连续"确定性失败"次数
    this._disabled = new Map();     // id -> 停用原因（至进程重启）
  }

  /** 被熔断的厂商，供面板标出来——静默停用比一直报错更难排查 */
  status() {
    return [...this._disabled.entries()].map(([id, reason]) => ({ id, reason }));
  }

  async poll() {
    // 离线：余额接口要带 API key 出站，离线模式下一律不发
    if (isOffline()) return;
    const env = await loadEnvFile(this.envPath);
    let changed = 0;
    for (const p of PROVIDERS) {
      if (this._disabled.has(p.id)) continue;
      const key = env[p.envKey];
      if (!key) continue;
      try {
        const j = await fetchJson(p.url, key, 10_000, this.fetchImpl);
        const out = p.parse(j);
        // 响应结构不认识 = 接口改版或本就不存在该端点，和 4xx 同属"重试无用"
        if (!out) throw Object.assign(new Error('unrecognized response'), { permanent: true });
        this.store.saveQuota(`balance:${p.id}`, Date.now(), { ...out, provider: p.name, currency: 'CNY' });
        this._clientErrors.delete(p.id);
        changed++;
      } catch (err) {
        this.log(`balance ${p.id}: ${err.message}`);
        // 网络抖动不计入（会自愈）；4xx / 结构不认识才累计，够了就停用
        const deterministic = err.permanent || (err.status >= 400 && err.status < 500);
        if (!deterministic) continue;
        const n = (this._clientErrors.get(p.id) || 0) + 1;
        this._clientErrors.set(p.id, n);
        if (n >= this.maxClientErrors) {
          this._disabled.set(p.id, `${err.message}（连续 ${n} 次，已停用至重启）`);
          this.log(`balance ${p.id}: 连续 ${n} 次确定性失败，停用至进程重启`);
        }
      }
    }
    if (changed > 0 && this.onChange) this.onChange();
  }

  start() {
    if (isOffline()) { this.log('balance: 离线模式，跳过余额轮询'); return; }
    setTimeout(() => this.poll().catch(() => {}), 3000).unref?.();
    this._timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs);
    this._timer.unref?.();
  }

  stop() { if (this._timer) clearInterval(this._timer); }
}
