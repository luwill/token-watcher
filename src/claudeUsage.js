import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME, isOffline } from './config.js';

/**
 * Claude 订阅官方配额轮询。
 *
 * 数据源是 Claude Code 自己的 OAuth 凭证（macOS 登录钥匙串 / Linux·Windows 的
 * ~/.claude/.credentials.json），调官方用量端点拿 5 小时窗与周窗的官方百分比——
 * 替代面板原有 session-blocks 推算的"估计值"（推算保留为无凭证时的兜底）。
 * 端点与响应字段（five_hour / seven_day / weekly_scoped，各含 used_percent 与
 * resets_at）与社区实测实现 TokenTracker / CodexBar 的口径一致。
 *
 * 凭证只在服务进程内使用，不入库、不进前端；401 时明确提示"跑一次 claude 刷新登录"。
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICES = ['Claude Code-credentials'];
const QUOTA_KEY = 'claude-usage';

/** 读取 Claude Code 的 OAuth accessToken。找不到凭证返回 null（未装/未登录都是正常态）。
 * TOKENMETER_NO_KEYCHAIN=1 时跳过钥匙串（测试进程不该摸宿主钥匙串）。 */
export function readClaudeOauthToken({
  platform = process.platform,
  home = HOME,
  execImpl = execFileSync,
  noKeychain = process.env.TOKENMETER_NO_KEYCHAIN === '1',
} = {}) {
  if (platform === 'darwin' && !noKeychain) {
    for (const service of KEYCHAIN_SERVICES) {
      try {
        const raw = execImpl('/usr/bin/security',
          ['find-generic-password', '-s', service, '-w'],
          { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        const oauth = JSON.parse(raw)?.claudeAiOauth;
        if (oauth?.accessToken) return oauth.accessToken;
      } catch { /* 未登录 / 用户拒绝钥匙串访问 */ }
    }
  }
  // Linux/Windows 主路径；macOS 上个别版本也落盘为同名文件
  return readFile(join(home, '.claude', '.credentials.json'), 'utf8')
    .then(t => JSON.parse(t)?.claudeAiOauth?.accessToken ?? null)
    .catch(() => null);
}

function window(w) {
  // 窗口对象主体用 used_percent；weekly_scoped 旧形状用 percent、2026-09 新版用
  // utilization（limits[] 元素同样带 percent）——上游实测三种命名并存
  const pct = Number(w?.used_percent ?? w?.percent ?? w?.utilization);
  if (!Number.isFinite(pct)) return null;
  return {
    used_percent: Math.max(0, Math.min(100, pct)),
    resets_at: typeof w?.resets_at === 'string' ? w.resets_at : null,
  };
}

/** 归一化 /api/oauth/usage 响应为稳定形状；结构不认识返回 null（接口改版≠0%）。
 * 2026-09 实测新形状：窗口主体用 utilization，scoped 周窗改在 limits[] 数组
 * （kind=weekly_scoped，percent + scope.model.display_name + is_active）。 */
export function normalizeUsage(body) {
  if (!body || typeof body !== 'object') return null;
  const five = window(body.five_hour);
  const seven = window(body.seven_day);
  const scoped = [];
  // 新形状：limits[] 里的 weekly_scoped 条目（is_active 才是当前生效的约束窗）
  for (const l of Array.isArray(body.limits) ? body.limits : []) {
    if (l?.kind !== 'weekly_scoped') continue;
    scoped.push({
      label: l?.scope?.model?.display_name || l?.scope?.model?.id || null,
      ...window(l),
    });
  }
  // 旧形状：顶层 weekly_scoped 数组
  for (const e of Array.isArray(body.weekly_scoped) ? body.weekly_scoped : []) {
    scoped.push({
      label: e?.scope?.model?.display_name || e?.scope?.model?.id || e?.label || null,
      ...window(e),
    });
  }
  const scopedOk = scoped.filter(e => e.label && Number.isFinite(e.used_percent));
  if (!five && !seven && scopedOk.length === 0) return null;
  return {
    five_hour: five,
    seven_day: seven,
    seven_day_opus: window(body.seven_day_opus),
    weekly_scoped: scopedOk,
  };
}

export async function fetchClaudeUsage(token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    },
  });
  if (res.status === 401) {
    throw Object.assign(new Error('token 过期（跑一次 claude 登录可刷新）'), { code: 'AUTH_EXPIRED' });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalizeUsage(await res.json());
}

/** 面板视图：最新快照 + 陈旧度；error 字段承载"为什么没有官方数字" */
export function claudeUsageView(store, { maxAgeMs = 30 * 60_000 } = {}) {
  const q = store.getQuota(QUOTA_KEY);
  if (!q) return null;
  const stale = Date.now() - q.ts > maxAgeMs;
  return { ...q.data, ts: q.ts, stale, error: stale ? '快照已过期（凭证失效或长期离线）' : null };
}

export class ClaudeUsagePoller {
  constructor(store, { log = () => {}, intervalMs = 10 * 60_000, fetchImpl = undefined } = {}) {
    this.store = store;
    this.log = log;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl;
    this.onChange = null;
    this._timer = null;
    this._lastError = null;
  }

  /** 最近一次失败原因，面板据此显示提示而不是无声缺卡 */
  status() { return this._lastError ? { error: this._lastError } : null; }

  async poll() {
    if (isOffline()) return;
    const token = await readClaudeOauthToken();
    if (!token) { this._lastError = null; return; } // 未登录 Claude Code：不算错误，静默跳过
    try {
      const data = await fetchClaudeUsage(token, this.fetchImpl ? { fetchImpl: this.fetchImpl } : {});
      if (data) {
        this.store.saveQuota(QUOTA_KEY, Date.now(), data);
        this._lastError = null;
        if (this.onChange) this.onChange();
      }
    } catch (err) {
      this._lastError = err.message;
      this.log(`claude usage: ${err.message}`);
    }
  }

  start() {
    if (isOffline()) return;
    setTimeout(() => this.poll().catch(() => {}), 15_000).unref?.();
    this._timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs);
    this._timer.unref?.();
  }

  stop() { if (this._timer) clearInterval(this._timer); }
}
