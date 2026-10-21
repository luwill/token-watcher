import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

export async function testDevices(ok) {
  const { Store } = await import('../src/store.js');
  const { startServer, buildSummary } = await import('../src/server.js');
  const { migrateDevices } = await import('../src/deviceTracking.js');
  const { HOME, DATA_DIR } = await import('../src/config.js');
  const dir = mkdtempSync(join(tmpdir(), 'tw-devices-'));
  const db = new DatabaseSync(join(dir, 'legacy.db'));
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY, ts INTEGER, tool TEXT, session_id TEXT, dedup_key TEXT, total_tokens INTEGER);
    CREATE TABLE tool_calls(ts INTEGER, tool TEXT, session_id TEXT, dedup_key TEXT, name TEXT);
    CREATE TABLE credit_usage(ts INTEGER, tool TEXT, dedup_key TEXT, amount REAL);
    CREATE TABLE files(path TEXT PRIMARY KEY, tool TEXT, session_id TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);`);
  const insert = db.prepare('INSERT INTO events VALUES (?, 1, ?, ?, ?, ?)');
  const file = db.prepare('INSERT INTO files VALUES (?, ?, ?)');
  const windows = join(DATA_DIR, 'remote/windows-usage/claude/projects/usage-test.jsonl');
  mkdirSync(join(DATA_DIR, 'remote/windows-usage/claude/projects'), { recursive: true });
  writeFileSync(windows, JSON.stringify({ type: 'assistant', sessionId: 'masked-session' }) + '\n');
  file.run(join(HOME, '.claude/projects/local.jsonl'), 'claude-code', 'local');
  file.run(join(DATA_DIR, 'remote/vps/claude/projects/server.jsonl'), 'claude-code', 'server');
  file.run(windows, 'claude-code', 'different-file-id');
  insert.run(1, 'claude-code', 'local', 'old-local', 10);
  insert.run(2, 'claude-code', 'server', 'old-vps', 20);
  insert.run(3, 'claude-code', 'masked-session', 'old-windows', 30);
  insert.run(4, 'claude-code', 'missing-history', 'old-orphan', 40);
  insert.run(5, 'cursor', null, 'old-poller', 5);
  const original = db.prepare('SELECT * FROM events ORDER BY id').all();
  migrateDevices(db);
  const attributed = db.prepare('SELECT * FROM events ORDER BY id').all();
  ok('设备历史补齐保留全部原字段与事件ID', attributed.every((r, i) => Object.entries(original[i]).every(([k, v]) => r[k] === v)));
  ok('Mac/VPS/Windows/历史未归属/本机轮询正确分区', attributed.map(r => r.device).join(',') === 'local,vps,windows,unknown,local');
  migrateDevices(db);
  ok('设备迁移重复执行不改变统计', db.prepare('SELECT SUM(total_tokens) t FROM events').get().t === 105);
  db.close();

  const store = new Store(join(dir, 'runtime.db'));
  const now = Date.now();
  const event = (key, total, tool = 'claude-code') => ({ ts: now - 1000, tool, model: 'deepseek-v4.1-flash',
    session_id: 'shared', input_tokens: total, total_tokens: total, dedup_key: key });
  store.insertEvent(event('local-request', 10));
  for (const [device, total] of [['vps', 20], ['windows', 30], ['unknown', 40]]) {
    const staged = store.stageWrites({ device });
    staged.store.insertEvent(event(`${device}-request`, total));
    staged.store.insertToolCall({ ts: now - 1000, tool: 'claude-code', session_id: 'shared', name: 'shell', dedup_key: `${device}-tool` });
    if (device === 'windows') store.insertEvent(event('poller-between-parse-and-replay', 5, 'cursor'));
    store.db.exec('BEGIN'); staged.replay(); store.db.exec('COMMIT');
  }
  ok('远端异步解析期间本机轮询保持本机归属', store.db.prepare("SELECT device FROM events WHERE tool='cursor'").get().device === 'local');
  store.insertEvent(event('windows-request', 30));
  ok('镜像重复不会增加事件或改变已知来源', store.db.prepare("SELECT device FROM events WHERE dedup_key='windows-request'").get().device === 'windows'
    && store.db.prepare('SELECT COUNT(*) n FROM events').get().n === 5);
  const saved = join(DATA_DIR, 'remote/windows-usage/codex/sessions/usage-file.jsonl');
  store.saveFile({ path: saved, tool: 'codex', session_id: 'usage-file', size: 10, mtime_ms: now, offset: 10 });
  ok('文件游标持久保存来源设备', store.db.prepare('SELECT device FROM files WHERE path=?').get(saved).device === 'windows');

  const scanner = new EventEmitter(); scanner.stats = {};
  const poller = { start() {}, status() { return []; } };
  let server;
  try {
    server = await startServer({ store, scanner, port: 0, balancePoller: poller,
      claudePoller: poller, cursorPoller: poller, zcodePoller: poller });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async path => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
    const all = await get('/api/summary?days=0');
    ok('默认全部设备保留总量', all.body.totals.all_time_tokens === 105 && all.body.device === 'all');
    let total = 0, costs = 0;
    for (const [device, expected] of [['local', 15], ['vps', 20], ['windows', 30], ['unknown', 40]]) {
      const summary = await get(`/api/summary?days=0&device=${device}`);
      total += summary.body.totals.all_time_tokens;
      costs += summary.body.costs.all_cny;
      ok(`${device}统计/图表/模型/工具/最近请求统一筛选`, summary.status === 200
        && summary.body.totals.all_time_tokens === expected
        && summary.body.by_day.reduce((s, d) => s + d.total, 0) === expected
        && summary.body.by_tool.reduce((s, t) => s + t.total, 0) === expected
        && summary.body.recent.every(e => e.device === device));
      ok(`${device}筛选仍展示所有设备总量`, summary.body.all_device_totals.all_time_tokens === 105);
      const date = new Date(now).toLocaleDateString('sv-SE');
      const sessions = await get(`/api/sessions?day=${date}&device=${device}`);
      const detail = await get(`/api/session/shared?tool=claude-code&device=${device}`);
      ok(`${device}会话列表与钻取保持设备隔离`, sessions.body.sessions.reduce((s, e) => s + e.total, 0) === expected
        && detail.body.events.reduce((s, e) => s + e.total_tokens, 0) === (device === 'local' ? 10 : expected));
      const tools = await get(`/api/tool-activity?days=0&device=${device}`);
      ok(`${device}工具活动遵循设备范围`, tools.body.tools.reduce((s, t) => s + t.n, 0) === (device === 'local' ? 0 : 1));
      const csv = await fetch(`${base}/api/export.csv?days=0&device=${device}`);
      const lines = (await csv.text()).trim().split('\n').slice(1);
      ok(`${device}CSV设备总量与面板一致`, lines.reduce((s, line) => s + Number(line.split(',')[6]), 0) === expected);
    }
    ok('所有设备分区之和等于总量且费用可相加', total === all.body.totals.all_time_tokens && Math.abs(costs - all.body.costs.all_cny) < 1e-8);
    // Historical cache keys must remain isolated when device wrappers share one connection.
    const historyTs = now - 3 * 24 * 3_600_000;
    for (const [device, amount] of [['local', 100], ['vps', 200], ['windows', 300]]) {
      const staged = store.stageWrites({ device });
      staged.store.insertEvent({ ...event(`history-${device}`, amount), ts: historyTs });
      staged.replay();
    }
    const expectedHistory = { all: 705, local: 115, vps: 220, windows: 330, unknown: 40 };
    let historicalQueries = 0;
    const prepare = store.db.prepare.bind(store.db);
    const boundary = new Date(now); boundary.setHours(0, 0, 0, 0);
    store.db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.includes('ts >= ? AND ts < ?')) {
        const all = statement.all.bind(statement);
        statement.all = (...args) => {
          if (args.at(-1) === boundary.getTime()) historicalQueries++;
          return all(...args);
        };
      }
      return statement;
    };
    const scoped = device => buildSummary(store, {}, 0, { now, device });
    for (let round = 0; round < 2; round++) {
      for (const device of ['windows', 'all', 'local', 'vps', 'unknown']) {
        const value = await scoped(device);
        ok(`${device}历史缓存第${round + 1}次切换保持分区及费用一致`,
          value.totals.all_time_tokens === expectedHistory[device]
          && value.by_day_all.reduce((sum, row) => sum + row.total, 0) === expectedHistory[device]
          && value.all_device_totals.all_time_tokens === 705);
      }
      if (round === 0) historicalQueries = 0;
    }
    ok('设备切换和全设备概览复用历史缓存', historicalQueries === 0);
    store.db.exec('BEGIN');
    try {
      const staged = store.stageWrites({ device: 'windows' });
      staged.store.insertEvent({ ...event('rolled-back-device-history', 999), ts: historyTs });
      staged.replay();
      ok('设备筛选在事务内可见自身历史写入', (await scoped('windows')).totals.all_time_tokens === 1329);
    } finally { store.db.exec('ROLLBACK'); }
    ok('设备筛选事务回滚不污染历史缓存', (await scoped('windows')).totals.all_time_tokens === 330);
    store.db.prepare = prepare;
    for (const path of ['/api/summary', '/api/sessions', '/api/session/shared', '/api/tool-activity', '/api/export.csv']) {
      ok(`${path}拒绝非法设备`, (await get(path + '?device=malicious')).status === 400);
    }
  } finally {
    if (server) await new Promise(r => server.close(r));
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
}
