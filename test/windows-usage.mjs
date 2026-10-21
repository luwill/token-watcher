import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { exportUsage, projectUsage } from '../scripts/windows-usage-export.mjs';
import { syncUsage, validateUsageText } from '../scripts/windows-usage-sync.mjs';
import { collectClaudeFile } from '../src/collectors/claude.js';
import { collectCodexFile } from '../src/collectors/codex.js';
import { Store } from '../src/store.js';

// Synthetic fixtures and in-memory SQLite only; never open a real usage database.
const root = mkdtempSync(join(tmpdir(), 'token-windows-usage-test-'));
const secret = 'DO_NOT_EXPORT_PRIVATE_CODE_ACCOUNT_KEY_PATIENT_ID';
const sid = '11111111-1111-1111-1111-111111111111';
const now = Date.parse('2026-10-14T01:00:00Z');
const ts = n => new Date(now + n * 1000).toISOString();
const u = (i, c, o) => ({ input_tokens: i, cached_input_tokens: c, output_tokens: o,
  reasoning_output_tokens: 1, total_tokens: i + o, secret });
const claude = [{ type: 'user', timestamp: ts(0), message: { content: secret } },
  { type: 'assistant', timestamp: ts(1), sessionId: sid, requestId: secret,
    cwd: `/company/${secret}`, message: { id: 'msg-' + secret, model: 'claude-opus-4-1',
      content: [{ type: 'text', text: secret }], usage: { input_tokens: 10,
        cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4, secret } } }];
claude.push({ ...claude[1], timestamp: ts(2), message: { ...claude[1].message,
  usage: { ...claude[1].message.usage, output_tokens: 12 } } });
const codex = [{ type: 'session_meta', timestamp: ts(0), payload: { id: sid, cwd: `/company/${secret}`, instructions: secret } },
  { type: 'turn_context', timestamp: ts(1), payload: { model: 'gpt-5.4', instructions: secret } },
  { type: 'event_msg', timestamp: ts(2), payload: { type: 'token_count', info: {
    total_token_usage: u(100, 20, 10), last_token_usage: u(100, 20, 10), secret }, rate_limits: { secret } } },
  { type: 'response_item', timestamp: ts(3), payload: { type: 'function_call', name: 'shell', arguments: secret, call_id: secret } },
  { type: 'event_msg', timestamp: ts(4), payload: { type: 'token_count', info: {
    total_token_usage: u(200, 30, 30), last_token_usage: u(100, 10, 20) }, secret } },
  { type: 'token_usage_record', timestamp: ts(5), payload: { response_id: secret, usage: u(50, 5, 6) } },
  { type: 'compacted', timestamp: ts(6), payload: { replacement_history: secret } },
  { type: 'event_msg', timestamp: ts(7), payload: { type: 'token_count', info: {
    total_token_usage: u(200, 30, 30), last_token_usage: u(1, 0, 0) } } }];
function write(path, records) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n'); }
const paths = { claude: join(root, '.claude/projects/private/session.jsonl'),
  codex: join(root, '.codex/sessions', `rollout-${sid}.jsonl`) };
write(paths.claude, claude); write(paths.codex, codex);
const projected = {};
for (const [tool, records] of [['claude-code', claude], ['codex', codex]]) {
  const text = records.map(r => projectUsage(tool, r, sid)).filter(Boolean).map(r => JSON.stringify(r)).join('\n') + '\n';
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes('content') && !text.includes('arguments') && !text.includes('instructions') && !text.includes('rate_limits'));
  validateUsageText(tool, text);
  projected[tool] = join(root, tool + '-projected.jsonl');
  writeFileSync(projected[tool], text);
}
assert.throws(() => validateUsageText('claude-code', JSON.stringify({ ...projectUsage('claude-code', claude[1], sid), content: secret })));
assert.throws(() => validateUsageText('claude-code', JSON.stringify({ ...projectUsage('claude-code', claude[1], sid), cwd: '/private/company/path' })));
assert.throws(() => validateUsageText('claude-code', JSON.stringify({ ...projectUsage('claude-code', claude[1], sid), sessionId: secret })));
console.log('PASS projection removes body, private paths, credentials, arguments and quota payloads');

function sink() { return new Store(':memory:'); }
function totals(s) { return s.db.prepare(`SELECT ts, model, input_tokens, cached_input,
  cache_write, output_tokens, reasoning_tokens, total_tokens FROM events ORDER BY ts, id`).all()
  .map(e => Object.values(e)); }
for (const [tool, fn, raw] of [['claude-code', collectClaudeFile, paths.claude], ['codex', collectCodexFile, paths.codex]]) {
  const original = sink(), safe = sink();
  await fn(original, { tool, path: raw, fileId: sid, offset: 0, version: 5 });
  await fn(safe, { tool, path: projected[tool], fileId: sid, offset: 0, version: 5 });
  assert.deepEqual(totals(safe), totals(original));
  if (tool === 'claude-code') assert.equal(safe.db.prepare('SELECT output_tokens FROM events').get().output_tokens, 12);
  const before = safe.db.prepare('SELECT COUNT(*) n FROM events').get().n;
  await fn(safe, { tool, path: projected[tool], fileId: sid, offset: 0, version: 5 });
  assert.equal(safe.db.prepare('SELECT COUNT(*) n FROM events').get().n, before);
  original.close(); safe.close();
}
console.log('PASS current collectors preserve tokens, models, timestamps and compaction; repeated scan is idempotent');

const report = await exportUsage({ home: root });
assert.equal(report.scanned, 2); assert.equal(report.changed, 2);
for (const f of report.files) assert.ok(!readFileSync(f.remote.slice(1), 'utf8').includes(secret));
assert.equal((await exportUsage({ home: root })).changed, 0);
appendFileSync(paths.claude, JSON.stringify({ ...claude[1], timestamp: ts(8), message: { ...claude[1].message, id: 'new-message' } }) + '\n');
assert.equal((await exportUsage({ home: root })).changed, 1);
const old = readFileSync(report.files.find(f => f.tool === 'codex').remote.slice(1), 'utf8');
write(paths.codex, codex.slice(0, 2));
const changed = await exportUsage({ home: root });
assert.equal(changed.rewrites, 1);
assert.equal(readFileSync(report.files.find(f => f.tool === 'codex').remote.slice(1), 'utf8'), old);
console.log('PASS exporter retains stable prefixes, skips unchanged files and preserves previous export on source rewrite');

const config = { mode: 'usage-metadata', target: 'test@192.0.2.10', interface: 'en0',
  remoteExportRoot: 'C:/Users/test/.tokenmeter/windows-usage-export', mirrorRoot: join(root, 'windows-usage') };
let calls = 0;
assert.throws(() => syncUsage({ ...config, mode: 'full-session-mirror' }, { exec() { calls++; } }));
assert.equal(calls, 0);
const relative = `claude/projects/usage-${sid}.jsonl`;
const text = readFileSync(projected['claude-code'], 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const file = { relative, tool: 'claude-code', remote: `/${config.remoteExportRoot}/usage/${relative}`,
  size: Buffer.byteLength(text), mtime: now, sha256: sha(text) };
const manifest = { version: 1, mode: 'usage-metadata', scanned: 1, files: [file] };
assert.throws(() => syncUsage(config, { exec(command) {
  calls++; assert.equal(command, '/usr/bin/ssh');
  return JSON.stringify({ ...manifest, files: [{ ...file, remote: '/C:/Users/test/.claude/projects/raw.jsonl' }] });
} }));
assert.equal(calls, 1, 'raw source must never reach SFTP');
function mock(command, args) {
  if (command === '/usr/bin/ssh') {
    assert.equal(args.at(-1), `node.exe "${config.remoteExportRoot}/exporter.mjs" --export`);
    return JSON.stringify(manifest);
  }
  assert.equal(command, '/usr/bin/sftp');
  writeFileSync(join(config.mirrorRoot, '.staging', sha(relative) + '.part'), text);
  calls++;
  return '';
}
assert.equal(syncUsage(config, { exec: mock }).downloaded, 1);
const downloads = calls;
assert.equal(syncUsage(config, { exec: mock }).downloaded, 0);
assert.equal(calls, downloads);
assert.equal(readFileSync(join(config.mirrorRoot, relative), 'utf8'), text);
console.log('PASS sync refuses raw mode and paths before download, validates metadata and skips unchanged hashes');
console.log('Fixtures retained:', root);
