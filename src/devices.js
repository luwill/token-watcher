import { sep, resolve } from 'node:path';
import { DATA_DIR, SOURCES, EXTRA_ROOTS } from './config.js';
import { CACHE_DB, CACHE_SCOPE, cachedHistory } from './historyCache.js';
import { localDayStart } from './timeRange.js';

export const DEVICE_IDS = ['local', 'vps', 'windows', 'unknown'];
export const DEVICE_LABELS = { local: process.platform === 'darwin' ? 'Mac' : '本机',
  vps: 'VPS', windows: 'Windows', unknown: '未归属' };
export function parseDevice(value = 'all') {
  return value === 'all' || DEVICE_IDS.includes(value) ? value : null;
}
function inside(path, root) { return path === root || path.startsWith(root + sep); }
export function sourceDevice(path, { dataDir = DATA_DIR, sources = SOURCES, extraRoots = EXTRA_ROOTS } = {}) {
  const file = resolve(path);
  for (const [folder, device] of [['windows-usage', 'windows'], ['vps', 'vps']]) {
    if (inside(file, resolve(dataDir, 'remote', folder))) return device;
  }
  if (Object.values(extraRoots).flat().some(root => inside(file, resolve(root)))) return 'unknown';
  return sources.some(s => (s.roots || []).some(root => inside(file, resolve(root)))) ? 'local' : 'unknown';
}

/** Read-only query scope. CTEs shadow only usage tables; account settings/quota remain global. */
export function deviceDb(db, device = 'all') {
  if (parseDevice(device) === null) throw new Error('Invalid device');
  if (device === 'all') return db;
  const ctes = ['events', 'tool_calls', 'credit_usage', 'files']
    .map(table => `${table} AS (SELECT * FROM main.${table} WHERE device = '${device}')`).join(', ');
  return { [CACHE_DB]: db, [CACHE_SCOPE]: device, prepare(sql) {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Device scope only supports SELECT');
    return db.prepare(`WITH ${ctes} ${sql}`);
  } };
}

export function deviceOverview(db, since, { now = Date.now() } = {}) {
  const boundary = localDayStart(now);
  const query = (start, end) => db.prepare(`SELECT device, COUNT(*) events, SUM(total_tokens) total,
    SUM(CASE WHEN ts >= ? THEN total_tokens ELSE 0 END) range_tokens,
    SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) range_events
    FROM events WHERE ts >= ? AND ts < ? GROUP BY device`).all(since, since, start, end);
  const totals = new Map();
  for (const row of [...cachedHistory(db, `devices:${since}`, boundary, b => query(0, b)),
    ...query(boundary, Number.MAX_SAFE_INTEGER)]) {
    const sum = totals.get(row.device) || { events: 0, total: 0, range_tokens: 0, range_events: 0 };
    for (const field of ['events', 'total', 'range_tokens', 'range_events']) sum[field] += row[field] || 0;
    totals.set(row.device, sum);
  }
  return DEVICE_IDS.map(id => ({ id, label: DEVICE_LABELS[id], events: 0, total: 0,
    range_tokens: 0, range_events: 0, ...totals.get(id) }));
}
