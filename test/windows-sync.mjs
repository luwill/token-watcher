import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWindows, validateManifest, quoteSftp } from '../scripts/windows-sync.mjs';

// Files only: no databases and no deletion. Keep fixtures as inspection receipts.
const temp = mkdtempSync(join(tmpdir(), 'token-windows-sync-test-'));
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const home = '/C:/Users/test';
const file = { bucket: 'claude/projects', relative: 'project with spaces/session.jsonl',
  remote: `${home}/.claude/projects/project with spaces/session.jsonl`, size: 4, mtime: 1_790_000_000_000 };
const manifest = files => ({ version: 1, home, roots: ['claude/projects'], files });

check('Only expected roots and file formats are accepted', () => {
  assert.equal(validateManifest(manifest([file])).length, 1);
  const compressed = { ...file, bucket: 'codex/sessions', relative: '2026/rollout.jsonl.zst',
    remote: `${home}/.codex/sessions/2026/rollout.jsonl.zst` };
  assert.equal(validateManifest({ ...manifest([compressed]), roots: ['codex/sessions'] }).length, 1);
  for (const bad of [
    { ...file, relative: '../secret.jsonl' }, { ...file, remote: `${home}/.ssh/id_ed25519` },
    { ...file, relative: 'line\nbreak.jsonl' }, { ...file, size: -1 },
    { ...file, bucket: 'config' }, { ...file, relative: 'tokens.db' },
  ]) assert.throws(() => validateManifest(manifest([bad])));
  assert.throws(() => validateManifest(manifest([file, file])));
});
check('SFTP paths quote spaces and reject control characters', () => {
  assert.equal(quoteSftp('/C:/project with spaces/log.jsonl'), '"/C:/project with spaces/log.jsonl"');
  assert.equal(quoteSftp('/C:/[work]/log.jsonl'), '"/C:/[work]/log.jsonl"');
  assert.throws(() => quoteSftp('/file\nget secret'));
});
const sftpServer = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server'].find(existsSync);
if (existsSync('/usr/bin/sftp') && sftpServer) check('Real OpenSSH SFTP treats quoted spaces and brackets literally', () => {
  const source = join(temp, '[windows] session.jsonl');
  const destination = join(temp, 'real-sftp-download.part');
  writeFileSync(source, 'fixture only\n');
  const result = spawnSync('/usr/bin/sftp', ['-q', '-D', sftpServer, '-b', '-', 'fixture'], {
    input: `get -p ${quoteSftp(source)} ${quoteSftp(destination)}\n`, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(destination, 'utf8'), 'fixture only\n');
});

const config = { mode: 'full-session-mirror', target: 'test@192.0.2.10', interface: 'en0',
  identityFile: join(temp, 'identity'), knownHostsFile: join(temp, 'known_hosts'), mirrorRoot: join(temp, 'mirror') };
writeFileSync(config.identityFile, 'fixture-only');
writeFileSync(config.knownHostsFile, 'fixture-only');
let before = manifest([file]);
let after = before;
let sshCalls = 0;
let transfers = 0;
let failTransfer = false;
let failManifest = false;
const exec = (bin, args, options) => {
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ProxyCommand=/usr/bin/nc -4 -b en0 -G 8 %h %p'));
  if (bin.endsWith('/ssh')) {
    if (failManifest) throw new Error('SSH failed');
    return JSON.stringify(sshCalls++ % 2 ? after : before);
  }
  assert.ok(bin.endsWith('/sftp'));
  transfers++;
  if (failTransfer) throw new Error('SFTP failed');
  for (const line of options.input.trim().split('\n')) {
    const match = line.match(/^get -p "([^"]+)" "([^"]+)"$/);
    assert.ok(match);
    const entry = before.files.find(f => f.remote === match[1]);
    assert.ok(entry);
    writeFileSync(match[2], 'x'.repeat(entry.size));
  }
  return '';
};
const run = () => { sshCalls = 0; return syncWindows(config, { exec }); };
const destination = join(config.mirrorRoot, 'claude/projects', file.relative);
const statePath = join(config.mirrorRoot, '.sync-state.json');

check('First sync publishes complete files and preserves remote mtime', () => {
  assert.equal(run().downloaded, 1);
  assert.equal(readFileSync(destination, 'utf8'), 'xxxx');
  assert.ok(Math.abs(statSync(destination).mtimeMs - file.mtime) < 1);
});
check('Unchanged files are not retransferred', () => {
  const oldTransfers = transfers;
  assert.equal(run().downloaded, 0);
  assert.equal(transfers, oldTransfers);
});
check('Failed transfer keeps previous mirror and cursor; retry recovers', () => {
  const saved = readFileSync(statePath, 'utf8');
  before = after = manifest([{ ...file, size: 5, mtime: file.mtime + 1000 }]);
  failTransfer = true;
  assert.throws(run);
  assert.equal(readFileSync(destination, 'utf8'), 'xxxx');
  assert.equal(readFileSync(statePath, 'utf8'), saved);
  failTransfer = false;
  assert.equal(run().downloaded, 1);
  assert.equal(readFileSync(destination, 'utf8'), 'xxxxx');
});
check('Changing remote file is deferred instead of publishing an unstable snapshot', () => {
  before = manifest([{ ...file, size: 6, mtime: file.mtime + 2000 }]);
  after = manifest([{ ...file, size: 7, mtime: file.mtime + 3000 }]);
  assert.equal(run().pending, 1);
  assert.equal(readFileSync(destination, 'utf8'), 'xxxxx');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).files[`claude/projects/${file.relative}`].size, 5);
});
check('Remote deletion does not delete a local historical log', () => {
  before = after = manifest([]);
  assert.equal(run().downloaded, 0);
  assert.equal(readFileSync(destination, 'utf8'), 'xxxxx');
});
check('SSH/manifest failure creates no new mirror directory', () => {
  failManifest = true;
  const other = { ...config, mirrorRoot: join(temp, 'unreachable') };
  assert.throws(() => syncWindows(other, { exec }));
  assert.equal(existsSync(other.mirrorRoot), false);
});
console.log(`${passed} checks passed; retained fixtures: ${temp}`);
