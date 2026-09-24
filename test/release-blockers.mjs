import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from '../src/cliArgs.js';
import { Store } from '../src/store.js';
import { canonicalCodexKey } from '../src/codexKeys.js';
import { readLinesFrom } from '../src/collectors/lines.js';

const SELF = fileURLToPath(import.meta.url);
const CLI = fileURLToPath(new URL('../bin/tokenwatcher.js', import.meta.url));

// 真实旧版表结构；不用新 Store 创建，以免提前写入迁移版本标记。
function legacyDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, tool TEXT NOT NULL, model TEXT,
    session_id TEXT, project TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0, dedup_key TEXT NOT NULL UNIQUE,
    project_path TEXT
  ); CREATE TABLE tool_calls (
    ts INTEGER NOT NULL, tool TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT,
    dedup_key TEXT NOT NULL UNIQUE
  )`);
  return db;
}
function seed(db, key, total = 100, output = 10, tool = 'codex') {
  db.prepare(`INSERT INTO events (ts, tool, model, input_tokens, output_tokens, total_tokens, dedup_key, project_path)
    VALUES (1, ?, 'test-model', ?, ?, ?, ?, '/synthetic/project')`).run(tool, total - output, output, total, key);
}
function seedCall(db, key) {
  db.prepare("INSERT INTO tool_calls VALUES (1, 'codex', 'shell', 's', ?)").run(key);
}

export async function testReleaseBlockers(ok) {
  console.log('\n[release] 四项发布阻断回归');
  const root = mkdtempSync(join(tmpdir(), 'tw-blockers-'));
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); }
    catch (err) { ok(name, false, err.stack); }
  };
  const envFor = (home) => ({ ...process.env, HOME: home, USERPROFILE: home,
    XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), TOKENMETER_OFFLINE: '1' });
  try {
    for (const name of ['serve', 'scan', 'today', 'sessions', 'wrapped', 'roi', 'doctor',
      'install-agent', 'uninstall-agent', 'uninstall', 'bar', 'leaderboard']) {
      await check(`CLI 昵称 ${name} 不改变 leaderboard 主命令`, () => {
        const args = parseArgs(['leaderboard', 'on', name]);
        assert.equal(args.cmd, 'leaderboard');
        assert.deepEqual(args.positionals, ['on', name]);
      });
    }
    await check('CLI 缺省、前置选项、选项值与 help/version 保持兼容', () => {
      assert.equal(parseArgs([]).cmd, 'serve');
      const args = parseArgs(['--port', '9000', 'sessions', '--out', 'uninstall', '--json']);
      assert.equal(args.cmd, 'sessions'); assert.equal(args.port, 9000);
      assert.equal(args.out, 'uninstall'); assert.equal(args.json, true);
      assert.equal(parseArgs(['--help']).help, true);
      assert.equal(parseArgs(['--version']).version, true);
      assert.throws(() => parseArgs(['typo', 'serve']), /未知命令/);
    });
    await check('未知 CLI 命令非零退出，且不迁移目录或创建数据库', () => {
      const home = join(root, 'unknown'); mkdirSync(join(home, '.token-stats'), { recursive: true });
      const r = spawnSync(process.execPath, [CLI, 'typo'], { env: envFor(home), encoding: 'utf8', timeout: 10000 });
      assert.equal(r.status, 1); assert.match(r.stderr, /未知命令/);
      assert.equal(existsSync(join(home, '.tokenmeter')), false);
      assert.equal(existsSync(join(home, '.token-stats')), true);
    });
    await check('真实 CLI 将保留字 today 保存为排行榜昵称（隔离且离线）', () => {
      const home = join(root, 'nickname'); mkdirSync(home);
      const r = spawnSync(process.execPath, [CLI, 'leaderboard', 'on', 'today'],
        { env: envFor(home), encoding: 'utf8', timeout: 15000 });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const db = new DatabaseSync(join(home, '.tokenmeter/tokenmeter.db'), { readOnly: true });
      try {
        const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, JSON.parse(r.value)]));
        assert.equal(settings['leaderboard.name'], 'today');
        assert.equal(settings['leaderboard.enabled'], true);
      } finally { db.close(); }
    });

    for (const kind of ['legacy', 'canonical', 'mixed']) {
      await check(`Codex ${kind} 库升级及归档重放不重复，原始行有归档`, () => {
        const path = join(root, `${kind}.db`); const db = legacyDb(path);
        if (kind !== 'canonical') {
          seed(db, 'codex:/sessions/rollout-a.jsonl:1', 120, 20);
          seedCall(db, 'codex:tc:/sessions/rollout-a.jsonl:call');
        }
        if (kind !== 'legacy') {
          seed(db, 'codex:file:rollout-a:1'); seedCall(db, 'codex:tc:file:rollout-a:call');
        }
        if (kind === 'mixed') {
          // canonical 胜出和输出相同按 total 决胜的两个反向例子。
          seed(db, 'codex:file:rollout-b:1', 150, 30);
          seed(db, 'codex:/sessions/rollout-b.jsonl:1', 100, 10);
          seed(db, 'codex:file:rollout-c:1', 100, 10);
          seed(db, 'codex:C:\\sessions\\rollout-c.jsonl:1', 130, 10);
          seed(db, 'codex:/archive/rollout-a.jsonl:1', 100, 10);
          seedCall(db, 'codex:tc:/archive/rollout-a.jsonl:call');
        }
        seed(db, 'other:unique', 50, 5, 'claude-code');
        const before = db.prepare('SELECT * FROM events ORDER BY id').all();
        const callsBefore = db.prepare('SELECT rowid AS source_rowid, * FROM tool_calls').all();
        db.close();
        let st = new Store(path);
        try {
          const count = kind === 'mixed' ? 4 : 2;
          const total = kind === 'mixed' ? 450 : kind === 'canonical' ? 150 : 170;
          assert.equal(st.countEvents().n, count); assert.equal(st.countEvents().total, total);
          assert.equal(st.insertEvent({ ts: 1, tool: 'codex', total_tokens: 100, output_tokens: 10,
            dedup_key: 'codex:/archived_sessions/rollout-a.jsonl:1' }), 0);
          assert.equal(st.insertToolCall({ ts: 1, tool: 'codex', name: 'shell',
            dedup_key: 'codex:tc:/archived_sessions/rollout-a.jsonl:call' }), 0);
          assert.equal(st.countEvents().total, total);
          assert.equal(st.db.prepare('SELECT COUNT(*) n FROM tool_calls').get().n, 1);
          if (kind !== 'canonical') {
            const archived = st.db.prepare("SELECT row_json FROM codex_key_migration_backup WHERE table_name='events'")
              .all().map(r => JSON.parse(r.row_json));
            for (const original of before.filter(r => r.tool === 'codex')) {
              assert.deepEqual(archived.find(r => r.id === original.id), { ...original });
            }
            for (const { source_rowid, ...original } of callsBefore) {
              const row = st.db.prepare("SELECT row_json FROM codex_key_migration_backup WHERE table_name='tool_calls' AND source_rowid=?").get(source_rowid);
              assert.deepEqual(JSON.parse(row.row_json), original);
            }
          }
          assert.equal(st.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
          st.close(); st = new Store(path);
          assert.equal(st.countEvents().n, count); assert.equal(st.countEvents().total, total);
        } finally { st.close(); }
      });
    }
    await check('Codex 迁移失败整体回滚，保留原始行且可重新打开重试', () => {
      const path = join(root, 'rollback.db'); const db = legacyDb(path);
      seed(db, 'codex:/old/a.jsonl:1'); seed(db, 'codex:/old/b.jsonl:1');
      seed(db, 'codex:file:b:1', 120, 20);
      seedCall(db, 'codex:tc:/old/a.jsonl:call');
      const before = db.prepare('SELECT * FROM events ORDER BY id').all();
      db.exec(`CREATE TRIGGER fail_migration BEFORE UPDATE OF dedup_key ON tool_calls
        BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END`);
      db.close();
      assert.throws(() => new Store(path), /synthetic migration failure/);
      const after = new DatabaseSync(path);
      try {
        assert.deepEqual(after.prepare('SELECT * FROM events ORDER BY id').all(), before);
        assert.equal(after.prepare("SELECT COUNT(*) n FROM settings WHERE key='migration:codex-keys:v1'").get().n, 0);
        assert.equal(after.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='codex_key_migration_backup'").get().n, 0);
        after.exec('DROP TRIGGER fail_migration');
      } finally { after.close(); }
      const st = new Store(path);
      try { assert.equal(st.countEvents().n, 2); assert.equal(st.countEvents().total, 220); }
      finally { st.close(); }
    });
    await check('Codex Windows 路径、工具调用与规范键归一幂等', () => {
      for (const key of ['codex:C:\\sessions\\rollout-a.jsonl:1', 'codex:tc:/old/rollout-a.jsonl:call',
        'codex:/sessions/file.jsonl.jsonl:1', 'other:key']) {
        const normalized = canonicalCodexKey(key);
        assert.equal(canonicalCodexKey(normalized), normalized);
      }
    });
    await check('流回调同步异常被 await 捕获且停止后续行', async () => {
      const path = join(root, 'throws.jsonl'); writeFileSync(path, 'one\ntwo\nthree\n');
      const failure = new Error('synthetic callback failure'); let calls = 0;
      await assert.rejects(readLinesFrom(path, 0, () => { calls++; throw failure; }), err => err === failure);
      assert.equal(calls, 1);
      await assert.rejects(readLinesFrom(join(root, 'missing'), 0, () => {}), { code: 'ENOENT' });
    });
    await check('逐行流 UTF-8 跨块、半行续写和字节游标保持正确', async () => {
      const path = join(root, 'utf8.jsonl'); const first = 'a'.repeat(65535) + '中';
      writeFileSync(path, first + '\n半'); const seen = [];
      const r = await readLinesFrom(path, 0, line => seen.push(line));
      assert.deepEqual(seen, [first]); assert.equal(r.newOffset, Buffer.byteLength(first + '\n'));
      appendFileSync(path, '行\n尾');
      const next = await readLinesFrom(path, r.newOffset, line => seen.push(line));
      assert.deepEqual(seen, [first, '半行']);
      assert.equal(next.newOffset, Buffer.byteLength(first + '\n半行\n'));
    });
    for (const fixture of ['scanner', 'api']) {
      await check(fixture === 'scanner' ? '真实扫描失败回滚当前文件、继续下一文件，下一轮可重试' :
        '真实 HTTP 全部/30/90 天 summary 与 CSV 一致，非法参数回落', () => {
        const home = join(root, fixture); mkdirSync(home);
        const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SELF, fixture],
          { env: envFor(home), encoding: 'utf8', timeout: 25000 });
        assert.equal(r.status, 0, r.error?.message || r.stderr + r.stdout);
        assert.match(r.stdout, /fixture passed/);
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function scannerFixture() {
  const { SOURCES } = await import('../src/config.js');
  const { Scanner } = await import('../src/scanner.js');
  const dir = join(process.env.HOME, 'logs'); mkdirSync(dir);
  SOURCES.splice(0, SOURCES.length, { tool: 'claude-code', collector: 'claude', kind: 'jsonl', roots: [dir], version: 1 });
  const record = (id) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { id, model: 'test-model', usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n';
  const bad = join(dir, 'a.jsonl'), good = join(dir, 'z.jsonl');
  writeFileSync(bad, record('first') + record('fail') + record('after'));
  writeFileSync(good, record('good'));
  const st = new Store(join(process.env.HOME, 'scanner.db'));
  try {
    const insert = st.insertEvent.bind(st); let fail = true;
    st.insertEvent = e => { if (fail && e.dedup_key.includes(':fail:')) throw new Error('synthetic insert failure'); return insert(e); };
    const scanner = new Scanner(st);
    const result = await scanner.scanAll({ quiet: true });
    assert.equal(result.inserted, 1); assert.equal(scanner.scanning, false);
    assert.equal(scanner.stats['claude-code'].parse_errors, 1);
    assert.equal(st.getFile(bad), undefined); assert(st.getFile(good));
    assert.equal(st.countEvents().n, 1); assert.equal(st.countEvents().total, 12);
    fail = false;
    assert.equal((await scanner.scanAll({ quiet: true })).inserted, 3);
    assert.equal(st.countEvents().n, 4); assert.equal(st.countEvents().total, 48);
    assert.equal(scanner.stats['claude-code'].parse_errors, 0);
  } finally { st.close(); }
}

async function apiFixture() {
  const { EventEmitter } = await import('node:events');
  const { startServer } = await import('../src/server.js');
  const st = new Store(join(process.env.HOME, 'api.db'));
  for (const [days, total] of [[0, 200], [60, 300], [100, 500]]) st.insertEvent({
    ts: Date.now() - days * 86400000, tool: 'codex', model: `fixture-${days}`, total_tokens: total, dedup_key: `fixture:${days}` });
  const scanner = new EventEmitter(); scanner.stats = {};
  const poller = () => ({ start() {}, status() { return []; } });
  const server = await startServer({ store: st, scanner, port: 0,
    balancePoller: poller(), claudePoller: poller(), cursorPoller: poller(), zcodePoller: poller() });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [query, range, total, rows] of [['?days=0', 0, 1000, 3], ['?days=30', 30, 200, 1],
      ['?days=90', 90, 500, 2], ['', 30, 200, 1], ['?days=', 30, 200, 1], ['?days=no', 30, 200, 1],
      ['?days=Infinity', 30, 200, 1], ['?days=-1', 30, 200, 1], ['?days=0.5', 30, 200, 1], ['?days=99999', 3650, 1000, 3]]) {
      const response = await fetch(`${base}/api/summary${query}`); assert.equal(response.status, 200);
      const s = await response.json(); assert.equal(s.range_days, range);
      assert.equal(s.totals.all_time_tokens, 1000);
      assert.equal(s.by_model.reduce((sum, r) => sum + r.total, 0), total);
      assert.equal(s.by_day.reduce((sum, r) => sum + r.total, 0), total);
      const csv = await fetch(`${base}/api/export.csv${query}`); assert.equal(csv.status, 200);
      const data = (await csv.text()).trim().split('\n').slice(1).map(line => line.split(','));
      assert.equal(data.length, rows); assert.equal(data.reduce((sum, r) => sum + Number(r[6]), 0), total);
      assert.match(csv.headers.get('content-disposition'), new RegExp(`-${range || 'all'}d.csv`));
    }
  } finally { await new Promise(resolve => server.close(resolve)); st.close(); }
}

if (['scanner', 'api'].includes(process.argv[2])) {
  try { await (process.argv[2] === 'scanner' ? scannerFixture() : apiFixture()); console.log('fixture passed'); process.exit(0); }
  catch (err) { console.error(err); process.exit(1); }
} else if (process.argv[2] === '--run') {
  let failed = 0;
  await testReleaseBlockers((name, pass, detail) => { console.log(`${pass ? '✓' : '✗'} ${name}`); if (!pass) { failed++; console.error(detail); } });
  process.exitCode = failed ? 1 : 0;
}
