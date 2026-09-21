import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME, isOffline } from './config.js';

/**
 * ZCode（GLM Coding Plan）官方配额轮询。
 *
 * 凭证复用 ZCode 自己的：~/.zcode/v2/config.json 里启用的 coding-plan provider
 * 自带明文 API key（无需解密 credentials.json），直接调官方 monitor 端点拿
 * 积分窗口。2026-09-21 本机实测（bigmodel coding plan，level=pro）：
 *   GET {origin}/api/monitor/usage/quota/limit   （origin = bigmodel.cn / api.z.ai）
 *   headers: { authorization: <apiKey> }         （裸 key，无 Bearer）
 *   → { code:200, data: { level, limits: [{ type, unit, number, usage, currentValue,
 *        remaining, percentage, nextResetTime }] } }
 * 字段语义（实测校验过，别按字段名望文生义）：
 *   - usage = 窗口总额度（12000），currentValue = 已用（725），number ≠ 额度；
 *   - percentage = 已用百分比（725/12000 = 6%，不是剩余）；
 *   - nextResetTime = 毫秒时间戳；unit=3 实测为 5 小时窗（重置 ~3h 后），
 *     unit=6 实测为每周窗（重置落在固定周几，如周五；用户确认套餐即按周刷新）。
 * 窗口标签只贴本机验证过的组合，没见过的 type/unit 如实显示原始值，不硬猜
 * （竞品按 TOKENS_LIMIT 类型找窗口、与本机 CREDIT_LIMIT 不同；unit=6=每周与其一致，
 * 曾因重置时间戳换算掉一位数误标"月度"，用户依套餐事实纠正）。
 *
 * 另有一个纯本地源：ZCode 自己轮询 MCP 调用配额并把完整响应写进
 * ~/.zcode/v2/logs/YYYY-MM-DD.log（"[usage-stats] 官方 MCP 额度响应"），
 * 离线也能读，无网络成本。积分窗口的响应不落日志，只能走网络。
 *
 * key 只在服务进程内使用，不入库、不进前端。
 */
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const DEFAULT_ORIGIN = {
  'builtin:bigmodel-coding-plan': 'https://bigmodel.cn',
  'builtin:zai-coding-plan': 'https://api.z.ai',
};
const QUOTA_KEY = 'zcode-plan';
const MCP_MAX_AGE_MS = 6 * 60 * 60_000;
/** 本机实测过的窗口标签；key = `${type}:${unit}` */
const WINDOW_LABELS = {
  'CREDIT_LIMIT:3': '5 小时',
  'CREDIT_LIMIT:6': '每周',
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** 读 ~/.zcode/v2/config.json 里启用且带 key 的 coding-plan provider（个人版实测可用；team 版需要组织路由头，不猜） */
export function zcodeQuotaTargets({ home = HOME } = {}) {
  return readFile(join(home, '.zcode', 'v2', 'config.json'), 'utf8')
    .then((t) => {
      const providers = JSON.parse(t)?.provider || {};
      const out = [];
      for (const [key, origin] of Object.entries(DEFAULT_ORIGIN)) {
        const p = providers[key];
        if (!p || p.enabled === false) continue;
        const apiKey = typeof p?.options?.apiKey === 'string' ? p.options.apiKey.trim() : '';
        if (apiKey) out.push({ providerKey: key, apiKey, origin });
      }
      return out;
    })
    .catch(() => []); // 未装 ZCode / 未登录：正常态
}

/** limits 数组 → 稳定窗口形状；结构不认识返回 null（接口改版≠0%） */
export function normalizeZcodeQuota(body) {
  const data = body?.data;
  const limits = Array.isArray(data?.limits) ? data.limits : null;
  if (!limits) return null;
  const windows = [];
  for (const l of limits) {
    if (!l || typeof l !== 'object') continue;
    const pct = num(l.percentage);
    const total = num(l.usage);
    const used = num(l.currentValue);
    const remaining = num(l.remaining);
    if (pct == null && (total == null || total <= 0 || used == null)) continue;
    // percentage 优先且已验证为"已用"；无 percentage 时按 currentValue/usage 折
    const usedPct = pct != null ? Math.max(0, Math.min(100, pct))
      : Math.max(0, Math.min(100, (used / total) * 100));
    windows.push({
      label: WINDOW_LABELS[`${l.type}:${l.unit}`] ?? `窗口 unit=${l.unit}`,
      used_percent: usedPct,
      used: pct != null && used == null ? null : used,
      total: pct != null && total == null ? null : total,
      remaining,
      resets_at: num(l.nextResetTime),
    });
  }
  if (!windows.length) return null;
  return {
    windows,
    level: typeof data.level === 'string' && data.level ? data.level : null,
  };
}

export async function fetchZcodeQuota(target, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(target.origin + QUOTA_PATH, {
    headers: { authorization: target.apiKey, Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('ZCode 未认证（跑一次 zcode 登录可刷新）'), { code: 'AUTH_EXPIRED' });
  }
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 走下面的 !ok 报错 */ }
  if (!res.ok) throw new Error(`ZCode 配额 API HTTP ${res.status}`);
  const code = num(body?.code);
  if (code != null && code !== 0 && code !== 200) {
    throw new Error(`ZCode 配额 API code=${code} ${body?.msg || ''}`);
  }
  return normalizeZcodeQuota(body);
}

/* ---------- MCP 调用配额：纯本地日志源 ---------- */

const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function readMcpFromLog(path, nowMs) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('官方 MCP 额度响应')) continue;
    const tsMatch = line.match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!tsMatch) continue;
    const ts = new Date(+tsMatch[1], +tsMatch[2] - 1, +tsMatch[3], +tsMatch[4], +tsMatch[5], +tsMatch[6]).getTime();
    if (nowMs - ts > MCP_MAX_AGE_MS || nowMs - ts < 0) return null; // 太旧：后面（更早的行）只会更旧
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const outer = JSON.parse(line.slice(start, line.lastIndexOf('}') + 1));
      const body = JSON.parse(outer.body);
      const u = body?.data?.total_usage;
      const used = num(u?.used), limit = num(u?.limit);
      if (body?.code !== 0 || used == null || limit == null || limit <= 0) continue;
      return { used, limit, remaining: num(u?.remaining), ts };
    } catch { continue; }
  }
  return null;
}

/** ZCode 自己落在日志里的 MCP 配额（1000 次/期）。今天没写就看昨天的日志。 */
export async function readZcodeMcpUsage({ home = HOME, nowMs = Date.now() } = {}) {
  const dir = join(home, '.zcode', 'v2', 'logs');
  const today = new Date(nowMs), yesterday = new Date(nowMs - 864e5);
  for (const d of [today, yesterday]) {
    const r = await readMcpFromLog(join(dir, `${dayStr(d)}.log`), nowMs);
    if (r) return r;
  }
  return null;
}

/* ---------- 面板视图与轮询 ---------- */

export function zcodeQuotaView(store, { maxAgeMs = 30 * 60_000 } = {}) {
  const q = store.getQuota(QUOTA_KEY);
  if (!q) return null;
  const stale = Date.now() - q.ts > maxAgeMs;
  return { ...q.data, ts: q.ts, stale, error: stale ? '快照已过期（凭证失效或长期离线）' : null };
}

export class ZcodeQuotaPoller {
  constructor(store, { log = () => {}, intervalMs = 10 * 60_000, fetchImpl = undefined, home = undefined } = {}) {
    this.store = store;
    this.log = log;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl;
    this.home = home;
    this.onChange = null;
    this._timer = null;
    this._lastError = null;
  }

  status() { return this._lastError ? { error: this._lastError } : null; }

  async poll() {
    // MCP 是本地日志，离线也读；积分窗口必须联网
    const mcp = await readZcodeMcpUsage(this.home ? { home: this.home } : {}).catch(() => null);
    const prev = this.store.getQuota(QUOTA_KEY);
    const targets = await zcodeQuotaTargets(this.home ? { home: this.home } : {});
    let data = null;
    if (!isOffline()) {
      for (const t of targets) {
        try {
          data = await fetchZcodeQuota(t, this.fetchImpl ? { fetchImpl: this.fetchImpl } : {});
          break;
        } catch (err) {
          this._lastError = `${t.providerKey}: ${err.message}`;
          this.log(`zcode quota: ${this._lastError}`);
        }
      }
    }
    // 网络失败但本地 MCP 日志新鲜：保留旧积分窗口、更新 MCP 部分，别整卡消失
    const merged = data
      ? { ...data, mcp }
      : (prev && mcp ? { ...prev.data, mcp } : null);
    if (merged && (data || mcp)) {
      // 只有 MCP 更新时保留原 ts：快照陈旧度跟踪的是"积分窗口的拉取时间"，否则
      // ZCode 一直开着（日志持续有新记录）会把过期的积分百分比永远刷成"新鲜"
      this.store.saveQuota(QUOTA_KEY, data ? Date.now() : prev.ts, merged);
      if (data) this._lastError = null;
      if (this.onChange) this.onChange();
    }
  }

  start() {
    setTimeout(() => this.poll().catch(() => {}), 15_000).unref?.();
    this._timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs);
    this._timer.unref?.();
  }

  stop() { if (this._timer) clearInterval(this._timer); }
}
