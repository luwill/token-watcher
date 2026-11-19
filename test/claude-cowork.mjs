import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { SOURCES } from '../src/config.js';
import { collectClaudeFile } from '../src/collectors/claude.js';
import { normalizeExtraRoot } from '../src/rootPaths.js';
import { coworkRoots, isCoworkUsagePath, descendClaudeDir } from '../src/claudePaths.js';

const T = '2026-10-14T00:00:00Z';
const usage = { input_tokens: 100, cache_read_input_tokens: 300,
  cache_creation_input_tokens: 50, output_tokens: 20 };
const standard = (id = 'msg_shared', patch = {}) => ({ type: 'assistant', timestamp: T,
  sessionId: 'session-a', requestId: 'request-a', cwd: '/work/project', entrypoint: 'local-agent',
  message: { id, model: 'claude-opus-4-6', usage, content: [{ type: 'tool_use', name: 'Read', id: 'call-a' }] }, ...patch });
const audit = (id = 'msg_shared', patch = {}) => ({ type: 'assistant',
  _audit_timestamp: '2026-10-14T00:00:01Z', session_id: 'session-a',
  message: { id, model: 'claude-opus-4-6', usage: { ...usage, output_tokens: 500 },
    content: [{ type: 'tool_use', name: 'Read', id: 'call-a' }] }, ...patch });

export async function testClaudeCowork(ok) {
  console.log('\n[claude] Cowork discovery / audit fallback / cross-format dedup / Windows paths');
  const root = mkdtempSync(join(tmpdir(), 'tw-cowork-'));
  const stores = [];
  const originals = SOURCES.slice();
  const source = originals.find(s => s.tool === 'claude-code');
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); } catch (err) { ok(name, false, err.stack); }
  };
  const makeStore = () => { const store = new Store(join(root, `s${stores.length}.db`)); stores.push(store); return store; };
  let n = 0;
  const fixture = (records, auditFile = false) => {
    const base = join(root, `f${n++}`, 'local-agent-mode-sessions', 'org', 'account', 'agent', 'local_ditto_session');
    const p = auditFile ? join(base, 'audit.jsonl') : join(base, '.claude', 'projects', '-work-project', 'session-a.jsonl');
    write(p, records);
    return p;
  };
  const write = (p, records) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n'); };
  const events = store => store.db.prepare("SELECT * FROM events WHERE tool='claude-code' ORDER BY dedup_key").all();
  const collect = async (store, p, offset = 0, tool = 'claude-code') => {
    const staged = store.stageWrites();
    const result = await collectClaudeFile(staged.store, { tool, path: p, fileId: path.basename(p, '.jsonl'), offset });
    store.db.exec('BEGIN');
    try { result.inserted = staged.replay(); store.db.exec('COMMIT'); }
    catch (err) { store.db.exec('ROLLBACK'); throw err; }
    return { ...result, changed: staged.changed };
  };
  const scanOnly = (roots) => SOURCES.splice(0, SOURCES.length, { ...source, roots });
  try {
    for (const [label, value, expected] of [
      ['POSIX absolute', ' /mirror/a/../b ', '/mirror/b'],
      ['POSIX tilde', '~/mirror', '/home/test/mirror'],
      ['POSIX relative', 'relative/a', null], ['POSIX rejects Windows drive', 'C:\\mirror', null],
    ]) await check(label, () => assert.equal(normalizeExtraRoot(value, '/home/test', path.posix), expected));
    for (const [label, value, expected] of [
      ['Windows drive', 'C:\\mirror', 'C:\\mirror'],
      ['Windows forward slashes', 'C:/mirror/a/../b', 'C:\\mirror\\b'],
      ['Windows UNC', '\\\\server\\share\\mirror', '\\\\server\\share\\mirror'],
      ['Windows tilde slash', '~/mirror', 'C:\\Users\\test\\mirror'],
      ['Windows tilde backslash', '~\\mirror', 'C:\\Users\\test\\mirror'],
      ['Windows drive relative rejected', 'C:mirror', null],
      ['Windows plain relative rejected', 'mirror\\a', null], ['empty rejected', '', null],
    ]) await check(label, () => assert.equal(normalizeExtraRoot(value, 'C:\\Users\\test', path.win32), expected));

    await check('Cowork roots: macOS, Windows roaming/MSIX and absent packages', () => {
      assert.deepEqual(coworkRoots('/home/test', { platform: 'darwin', pathMod: path.posix }),
        ['/home/test/Library/Application Support/Claude/local-agent-mode-sessions']);
      const dirs = ['Claude_family', 'Claude_other', 'OtherApp_family'].map(name => ({ name, isDirectory: () => true }));
      dirs.push({ name: 'Claude_file', isDirectory: () => false });
      const roots = coworkRoots('C:\\Users\\test', { platform: 'win32', pathMod: path.win32,
        env: { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' }, readDir: () => dirs });
      assert.equal(roots.length, 3);
      assert.equal(roots[0], 'D:\\Roaming\\Claude\\local-agent-mode-sessions');
      assert.equal(roots[1], 'D:\\Local\\Packages\\Claude_family\\LocalCache\\Roaming\\Claude\\local-agent-mode-sessions');
      assert.equal(coworkRoots('C:\\Users\\test', { platform: 'win32', pathMod: path.win32,
        env: {}, readDir: () => { throw new Error('absent'); } }).length, 1);
      assert.deepEqual(coworkRoots('/home/test', { platform: 'linux' }), []);
    });
    await check('Default config registers this platform Cowork roots and v4', () => {
      assert.equal(source.version, 4); // v4: 测速回填 duration_ms
      for (const p of coworkRoots(process.env.HOME)) assert(source.roots.includes(p));
    });
    await check('Discovery accepts hidden transcript/audit; excludes generated files and prunes outputs/plugins', () => {
      const base = '/data/local-agent-mode-sessions/org/account/agent/local_ditto_session';
      assert(isCoworkUsagePath(`${base}/audit.jsonl`, path.posix));
      assert(isCoworkUsagePath(`${base}/.claude/projects/project/session.jsonl`, path.posix));
      assert(isCoworkUsagePath(`${base}/.claude/projects/project/session/subagents/agent-a.jsonl`, path.posix));
      assert(!isCoworkUsagePath(`${base}/outputs/audit.jsonl`, path.posix));
      assert(!isCoworkUsagePath(`${base}/outputs/random.jsonl`, path.posix));
      assert(!descendClaudeDir(`${base}/outputs`, path.posix));
      assert(!descendClaudeDir('/data/local-agent-mode-sessions/org/account/cowork_plugins', path.posix));
      assert(descendClaudeDir(`${base}/.claude/projects`, path.posix));
      assert(isCoworkUsagePath(base.replaceAll('/', '\\') + '\\.claude\\projects\\project\\session.jsonl', path.win32));
    });
    await check('CLI add/list/remove and config loading use actual host absolute paths', () => {
      const home = join(root, 'cli-home');
      const mirror = join(home, 'mirror');
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const bin = new URL('../bin/tokenwatcher.js', import.meta.url);
      const run = args => spawnSync(process.execPath, [fileURLToPath(bin), ...args], { encoding: 'utf8', env });
      const { status, stderr } = run(['extra-roots', 'add', 'claude-code', mirror]);
      assert.equal(status, 0, stderr);
      assert.equal(run(['extra-roots', 'add', 'claude-code', mirror]).status, 0);
      assert.deepEqual(JSON.parse(readFileSync(join(home, '.tokenmeter/extra-roots.json'))), { 'claude-code': [mirror] });
      const config = new URL('../src/config.js', import.meta.url).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const {SOURCES}=await import(${JSON.stringify(config)});console.log(JSON.stringify(SOURCES.find(s=>s.tool==='claude-code').roots))`], { encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr);
      assert(JSON.parse(result.stdout).includes(mirror));
      assert.equal(run(['extra-roots', 'remove', 'claude-code', mirror]).status, 0);
      assert.equal(run(['extra-roots', 'add', 'claude-code', 'C:relative']).status, 1);
    });

    await check('Standard-only token/cache totals and tool calls remain exact', async () => {
      const store = makeStore(); await collect(store, fixture([standard()]));
      const [e] = events(store);
      assert.equal(e.total_tokens, 470); assert.equal(e.cached_input, 300);
      assert.equal(e.cache_write, 50); assert.equal(e.usage_quality, 2);
      assert.equal(e.project, 'project'); assert.equal(e.session_id, 'session-a');
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM tool_calls').get().n, 1);
    });
    await check('Audit-only timestamps/session IDs and modelUsage exclusion', async () => {
      const store = makeStore();
      await collect(store, fixture([audit(), { type: 'result', modelUsage: { 'other-model': { inputTokens: 99999 } } }], true));
      const [e] = events(store);
      assert.equal(events(store).length, 1); assert.equal(e.ts, Date.parse('2026-10-14T00:00:01Z'));
      assert.equal(e.usage_quality, 1); assert.equal(e.session_id, 'session-a'); assert.equal(e.total_tokens, 950);
    });
    for (const reverse of [false, true]) await check(`Transcript/audit ${reverse ? 'reverse' : 'forward'} order: one event, standard wins even with smaller output`, async () => {
      const store = makeStore(); const paths = [fixture([standard()]), fixture([audit()], true)];
      if (reverse) paths.reverse();
      for (const p of paths) await collect(store, p);
      assert.equal(events(store).length, 1); assert.equal(events(store)[0].total_tokens, 470);
      assert.equal(events(store)[0].ts, Date.parse(T)); assert.equal(events(store)[0].usage_quality, 2);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM tool_calls').get().n, 1);
      for (const p of paths) assert.equal((await collect(store, p)).changed, false);
    });
    await check('Audit timestamp plus standard-looking timestamp still stays fallback', async () => {
      const store = makeStore(); await collect(store, fixture([standard()]));
      await collect(store, fixture([audit('msg_shared', { timestamp: T })], true));
      assert.equal(events(store)[0].total_tokens, 470);
    });
    await check('Mirrors with changed requestId/filename do not duplicate or churn timestamp', async () => {
      const store = makeStore(); await collect(store, fixture([standard()]));
      const mirror = fixture([standard('msg_shared', { requestId: 'other', timestamp: '2026-10-14T00:10:00Z' })]);
      assert.equal((await collect(store, mirror)).changed, false);
      assert.equal(events(store).length, 1); assert.equal(events(store)[0].ts, Date.parse(T));
      assert.equal((await collect(store, fixture([standard('msg_shared', { requestId: undefined })]))).changed, false);
    });
    await check('Source priority persists across store reopen; late audit cannot replace standard history', async () => {
      const index = stores.length; const store = makeStore();
      await collect(store, fixture([standard()])); store.close();
      const reopened = new Store(join(root, `s${index}.db`)); stores[index] = reopened;
      assert.equal((await collect(reopened, fixture([audit()], true))).changed, false);
      assert.equal(events(reopened).length, 1); assert.equal(events(reopened)[0].total_tokens, 470);
      assert.equal(events(reopened)[0].usage_quality, 2);
    });
    await check('Message identity matching a key namespace cannot remove unrelated canonical events', async () => {
      const store = makeStore(); await collect(store, fixture([standard('msg_keep'), standard('message')]));
      assert.equal(events(store).length, 2);
      assert(events(store).some(e => e.dedup_key === 'claude-code:message:msg_keep'));
      await collect(store, fixture([standard('msg_keep', { message: { id: 'msg_keep', model: 'claude-opus-4-6',
        usage: { ...usage, output_tokens: 100 } } })]));
      assert.equal(events(store).length, 2); assert.equal(events(store).find(e => e.dedup_key.endsWith('msg_keep')).total_tokens, 550);
    });
    await check('Incremental fragments fill output/cache exactly once; incomplete line is retried', async () => {
      const store = makeStore(); const p = fixture([standard('msg_late', { message: { id: 'msg_late', model: 'claude-opus-4-6', usage: { input_tokens: 0, output_tokens: 0 } } })]);
      const first = await collect(store, p);
      const final = JSON.stringify(standard('msg_late'));
      appendFileSync(p, final.slice(0, 20));
      assert.equal((await collect(store, p, first.newOffset)).newOffset, first.newOffset);
      appendFileSync(p, final.slice(20) + '\n');
      assert.equal((await collect(store, p, first.newOffset)).inserted, 0);
      assert.equal(events(store).length, 1); assert.equal(events(store)[0].total_tokens, 470);
      const lateInput = standard('msg_equal', { message: { id: 'msg_equal', model: 'claude-opus-4-6', usage: { input_tokens: 0, output_tokens: 20 } } });
      await collect(store, fixture([lateInput, standard('msg_equal')]));
      assert.equal(events(store).find(e => e.dedup_key.endsWith('msg_equal')).total_tokens, 470);
    });
    await check('Old requestId keys merge only observed identity; missing-source/ccmr history survives', async () => {
      const store = makeStore();
      const seed = (key, output, tool = 'claude-code') => store.insertEvent({ ts: Date.parse(T), tool, model: 'claude-opus-4-6', session_id: 'session-a',
        project: 'project', input_tokens: 100, cached_input: 300, cache_write: 50, output_tokens: output,
        total_tokens: 450 + output, dedup_key: key });
      seed('claude-code:msg_shared:r1', 10); seed('claude-code:msg_shared:r2', 20);
      seed('claude-code:msg_shared-extra:r3', 30); seed('ccmr:msg_shared:r1', 40, 'ccmr');
      await collect(store, fixture([audit()], true));
      assert.equal(events(store).length, 2); assert.equal(events(store).find(e => e.dedup_key === 'claude-code:message:msg_shared').total_tokens, 470);
      assert(store.db.prepare('SELECT 1 FROM events WHERE dedup_key=?').get('claude-code:msg_shared-extra:r3'));
      assert(store.db.prepare('SELECT 1 FROM events WHERE dedup_key=?').get('ccmr:msg_shared:r1'));
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM events WHERE dedup_key IN (?,?)').get('claude-code:msg_shared:r1', 'claude-code:msg_shared:r2').n, 0);
      assert.equal((await collect(store, fixture([standard()]))).changed, false);
    });
    await check('ccmr keeps its requestId keys and output completion rule', async () => {
      const store = makeStore(); const p = fixture([standard(), standard('msg_shared', { requestId: 'request-b' })]);
      await collect(store, p, 0, 'ccmr');
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE tool='ccmr'").get().n, 2);
    });
    await check('Malformed, synthetic, non-assistant, invalid token and unidentified audit rows are ignored', async () => {
      const store = makeStore();
      const bad = [standard('msg_bad', { type: 'user' }), standard('msg_bad', { timestamp: 'bad' }),
        audit('msg_bad', { session_id: undefined }), ...[-1, '123', null].map(value => standard('msg_bad', {
          message: { id: 'msg_bad', model: 'claude-opus-4-6', usage: { input_tokens: value } } })),
        standard('msg_bad', { message: { id: 'msg_bad', model: '<synthetic>', usage } }),
        standard('msg_bad', { message: { id: 'msg_bad', model: 'claude-opus-4-6', usage: {} } })];
      const p = fixture(bad); appendFileSync(p, '{broken}\n');
      await collect(store, p); assert.equal(events(store).length, 0);
      writeFileSync(p, JSON.stringify(standard('msg_spaced'), null, 0).replace('"type":"assistant"', '"type": "assistant"') + '\n');
      await collect(store, p); assert.equal(events(store).length, 1);
    });
    await check('Scanner discovers hidden Cowork files, ignores outputs, rescans v2 keys and remains idempotent', async () => {
      const store = makeStore(); const p = fixture([standard()]);
      const agent = dirname(dirname(dirname(dirname(p))));
      const a = join(agent, 'audit.jsonl'); write(a, [audit()]);
      const generated = join(agent, 'outputs', 'copy.jsonl'); write(generated, [standard('msg_fake')]);
      const rootPath = join(agent, '..', '..', '..', '..'); scanOnly([rootPath]);
      store.insertEvent({ ts: Date.parse(T), tool: 'claude-code', output_tokens: 20, total_tokens: 470, input_tokens: 100,
        cached_input: 300, cache_write: 50, dedup_key: 'claude-code:msg_shared:request-a' });
      const stat = (await import('node:fs')).statSync(p);
      store.saveFile({ path: p, tool: 'claude-code', size: stat.size, mtime_ms: stat.mtimeMs, offset: stat.size, state_json: '{"_v":2}' });
      const scanner = new Scanner(store); let updates = 0; scanner.on('update', () => updates++);
      await scanner.scanAll(); assert.equal(events(store).length, 1); assert.equal(events(store)[0].total_tokens, 470);
      assert(store.getFile(a)); assert(!store.getFile(generated)); assert.equal(updates, 1);
      await scanner.scanAll(); assert.equal(updates, 1);
      rmSync(p); await scanner.scanAll();
      assert(!store.getFile(p)); assert.equal(events(store)[0].usage_quality, 2); assert.equal(events(store)[0].total_tokens, 470);
      appendFileSync(a, JSON.stringify(audit()) + '\n'); await scanner.scanAll(); assert.equal(events(store).length, 1);
    });
    await check('Scanner failure rolls back alias migration/cursor, then retry succeeds', async () => {
      const store = makeStore(); const p = fixture([standard()]); scanOnly([dirname(p)]);
      store.insertEvent({ ts: Date.parse(T), tool: 'claude-code', input_tokens: 100, output_tokens: 0, total_tokens: 100,
        dedup_key: 'claude-code:msg_shared:request-a' });
      const save = store.saveFile; store.saveFile = () => { throw new Error('synthetic cursor failure'); };
      const scanner = new Scanner(store); await scanner.scanAll();
      assert.equal(scanner.stats['claude-code'].parse_errors, 1);
      assert.equal(events(store)[0].dedup_key, 'claude-code:msg_shared:request-a'); assert(!store.getFile(p));
      store.saveFile = save; await scanner.scanAll();
      assert.equal(events(store).length, 1); assert.equal(events(store)[0].dedup_key, 'claude-code:message:msg_shared');
      assert.equal(events(store)[0].total_tokens, 470); assert(store.getFile(p));
    });
  } finally {
    SOURCES.splice(0, SOURCES.length, ...originals);
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
