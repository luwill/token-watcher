/** 告警配置与求值：阈值只在这里定义，求值函数不做 I/O。 */
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';

const METRICS = ['codex_quota_pct', 'balance', 'today_tokens', 'claude_5h_tokens'];
export function defaultAlertsConfig() {
  return { version: 1, rules: METRICS.map(metric => ({
    id: metric, metric, enabled: ['codex_quota_pct', 'balance'].includes(metric),
    warn: metric === 'codex_quota_pct' ? 80 : metric === 'balance' ? 10 : null,
    crit: metric === 'codex_quota_pct' ? 95 : metric === 'balance' ? 2 : null,
  })) };
}

export function validateAlertsConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['配置必须是对象'];
  if (config.version !== 1) errors.push('version 必须为 1');
  if (!Array.isArray(config.rules)) return [...errors, 'rules 必须是数组'];
  const ids = new Set();
  config.rules.forEach((r, i) => {
    const fail = msg => errors.push(`规则 ${i + 1}：${msg}`);
    if (!r || typeof r !== 'object' || Array.isArray(r)) { fail('必须是对象'); return; }
    if (typeof r.id !== 'string' || !r.id.trim()) fail('id 必须是非空字符串');
    else if (ids.has(r.id)) fail('id 重复');
    else ids.add(r.id);
    if (!METRICS.includes(r.metric)) fail('未知 metric');
    if (typeof r.enabled !== 'boolean') fail('enabled 必须是布尔值');
    if (r.provider !== undefined && (r.metric !== 'balance' || typeof r.provider !== 'string' || !r.provider.trim())) {
      fail('provider 仅支持 balance，且必须是非空字符串');
    }
    for (const k of ['warn', 'crit']) {
      if (r[k] !== null && (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < 0
        || (r.metric === 'codex_quota_pct' && r[k] > 100))) fail(`${k} 必须是有限非负数或 null，百分比不可超过 100`);
    }
    if (r.enabled && r.warn === null && r.crit === null) fail('启用时至少设置一个阈值');
    if (typeof r.warn === 'number' && typeof r.crit === 'number'
      && (r.metric === 'balance' ? r.warn < r.crit : r.warn > r.crit)) fail('warn / crit 顺序与指标方向不一致');
  });
  return errors;
}

export async function loadAlertsConfig() {
  try {
    const config = JSON.parse(await readFile(join(DATA_DIR, 'alerts.json'), 'utf8'));
    if (validateAlertsConfig(config).length) return { config: defaultAlertsConfig(), config_error: '告警配置校验失败，已使用默认规则' };
    return { config, config_error: null };
  } catch (err) {
    return { config: defaultAlertsConfig(), config_error: err.code === 'ENOENT' ? null : '告警配置无法读取或 JSON 损坏，已使用默认规则' };
  }
}

export async function saveAlertsConfig(config) {
  const details = validateAlertsConfig(config);
  if (details.length) throw new Error('告警配置校验失败');
  await mkdir(DATA_DIR, { recursive: true });
  const temp = join(DATA_DIR, `.alerts-${randomUUID()}.tmp`);
  // 并发 PUT 各用独立临时文件，rename 原子替换，最后一次写入生效；失败时不留临时文件
  try {
    await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, join(DATA_DIR, 'alerts.json'));
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' };
/** 告警正文里的数值：余额沿用旧菜单栏的「¥x.xx」，配额带 %，tokens 千分位 */
function fmt(metric, n, currency = 'CNY') {
  if (metric === 'balance') return `${CURRENCY_SYMBOL[currency ?? 'CNY'] ?? `${currency} `}${n.toFixed(2)}`;
  if (metric === 'codex_quota_pct') return `${Math.round(n * 10) / 10}%`;
  return Math.round(n).toLocaleString('en-US');
}
export function evaluateAlerts(summary, config) {
  const items = [];
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    let values = [];
    if (rule.metric === 'codex_quota_pct') {
      const q = summary.quota?.codex?.data ?? summary.quota?.codex;
      // reduce 而非 Math.max(...)：窗口数组来自上游原样透传，展开超长数组会抛 RangeError
      const max = (q?.windows || []).reduce((m, w) => (finite(w?.used_percent) && (m === null || w.used_percent > m) ? w.used_percent : m), null);
      values = [{ value: max ?? q?.used_percent, title: 'Codex 配额' }];
    } else if (rule.metric === 'balance') {
      values = (summary.balances || []).filter(b => !rule.provider || b.id === rule.provider || b.provider === rule.provider)
        .map(b => ({ value: b.balance, suffix: b.id ?? b.provider, currency: b.currency, title: `${b.provider ?? b.id ?? '?'} 余额` }));
    } else if (rule.metric === 'today_tokens') values = [{ value: summary.totals?.today_tokens, title: '今日 Tokens' }];
    else if (rule.metric === 'claude_5h_tokens' && summary.quota?.claude5h?.active === true) {
      values = [{ value: summary.quota.claude5h.window_tokens, title: 'Claude 5h Tokens' }];
    }
    for (const { value, suffix, currency, title } of values) {
      if (!finite(value)) continue;
      const hit = threshold => threshold !== null && (rule.metric === 'balance' ? value < threshold : value >= threshold);
      const level = hit(rule.crit) ? 'crit' : hit(rule.warn) ? 'warn' : null;
      if (!level) continue;
      // 默认条件键保持简短；自定义规则始终带 id，增删其他规则不会改变当前键。
      const key = rule.metric + (suffix != null ? `:${encodeURIComponent(suffix)}` : '')
        + (rule.id !== rule.metric ? `:rule:${encodeURIComponent(rule.id)}` : '');
      items.push({ key, rule_id: rule.id, metric: rule.metric, level, value, threshold: rule[level],
        title: `${title}${level === 'crit' ? '严重告警' : '警告'}`,
        body: `当前 ${fmt(rule.metric, value, currency)}，${rule.metric === 'balance' ? '低于' : '达到'}阈值 ${fmt(rule.metric, rule[level], currency)}` });
    }
  }
  return items.sort((a, b) => (a.level === 'crit' ? 0 : 1) - (b.level === 'crit' ? 0 : 1));
}

/**
 * /api/summary 的 alerts 字段。求值出错只清空告警（带 eval_error 供排查），
 * 不能让整份用量 summary 跟着 500——菜单栏会因此只剩 T--。
 */
export function alertsView(summary, { config, config_error }, log = () => {}) {
  try {
    return { items: evaluateAlerts(summary, config), config_error, rules: config.rules };
  } catch (err) {
    log(`告警求值失败：${err.message}`);
    return { items: [], config_error, rules: Array.isArray(config?.rules) ? config.rules : [], eval_error: '告警求值失败' };
  }
}
