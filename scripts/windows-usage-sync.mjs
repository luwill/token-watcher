/** Mac side: download only files produced by the Windows usage-only exporter. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectUsage } from './windows-usage-export.mjs';

function quoteSftp(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Control character in file path');
  return '"' + value.replace(/[\\"]/g, '\\$&') + '"';
}

export function validateUsageText(tool, text) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    const record = JSON.parse(line);
    const projected = projectUsage(tool, record, 'validation');
    if (!projected) throw new Error('Invalid usage-only record');
    if (record.cwd !== undefined && record.cwd !== '/windows-office') throw new Error('Unexpected project path');
    if (record.payload?.cwd !== undefined && record.payload.cwd !== '/windows-office') throw new Error('Unexpected project path');
    // Reject unknown fields recursively, regardless of whether the receiver would ignore them.
    function check(value, allowed) {
      if (value === null || typeof value !== 'object') return;
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(allowed, key)) throw new Error('Unexpected field in usage metadata');
        check(value[key], allowed[key]);
      }
    }
    check(record, projected);
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    for (const id of [record.sessionId, record.requestId, record.message?.id,
      record.payload?.session_id, record.payload?.parent_thread_id, record.payload?.response_id]) {
      if (id !== undefined && (typeof id !== 'string' || !uuid.test(id))) throw new Error('Unmasked usage identifier');
    }
  }
}

export function syncUsage(config, { exec = execFileSync } = {}) {
  if (config.mode !== 'usage-metadata') throw new Error('Only usage-metadata sync is authorized');
  if (!/^[A-Za-z0-9_.-]+@[0-9.]+$/.test(config.target) || !/^[a-z0-9]+$/i.test(config.interface)
    || !/^C:\/Users\/[A-Za-z0-9_.-]+\/\.tokenmeter\/windows-usage-export$/.test(config.remoteExportRoot)
    || typeof config.mirrorRoot !== 'string' || !isAbsolute(config.mirrorRoot)
    || basename(config.mirrorRoot) !== 'windows-usage') {
    throw new Error('Invalid usage sync configuration');
  }
  const options = ['-F', '/dev/null', '-i', config.identityFile, '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${config.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-o', `ProxyCommand=/usr/bin/nc -4 -b ${config.interface} -G 8 %h %p`];
  const raw = exec('/usr/bin/ssh', [...options, config.target,
    `node.exe "${config.remoteExportRoot}/exporter.mjs" --export`], {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const report = JSON.parse(raw.trim());
  if (report.version !== 1 || report.mode !== 'usage-metadata' || !Array.isArray(report.files)) throw new Error('Invalid usage export report');
  if (report.unsupported || report.rewrites) throw new Error('Exporter needs attention: compressed or rewritten source');
  const root = config.mirrorRoot;
  mkdirSync(join(root, '.staging'), { recursive: true, mode: 0o700 });
  const statePath = join(root, '.usage-sync-state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  let downloaded = 0, bytes = 0;
  for (const file of report.files) {
    if (!/^(claude\/projects|codex\/sessions)\/usage-[a-f0-9-]{36}\.jsonl$/.test(file.relative)
      || !['claude-code', 'codex'].includes(file.tool)
      || (file.relative.startsWith('claude/') ? file.tool !== 'claude-code' : file.tool !== 'codex')
      || file.remote !== `/${config.remoteExportRoot}/usage/${file.relative}`
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0
      || !Number.isSafeInteger(file.mtime) || file.mtime < 0) throw new Error('Export path outside approved usage directory');
    const destination = join(root, file.relative);
    if (state[file.relative] === file.sha256 && existsSync(destination) && statSync(destination).size === file.size) continue;
    const staged = join(root, '.staging', createHash('sha256').update(file.relative).digest('hex') + '.part');
    exec('/usr/bin/sftp', [...options, '-b', '-', config.target], { input: `get -p ${quoteSftp(file.remote)} ${quoteSftp(staged)}\n`,
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    const data = readFileSync(staged);
    if (data.length !== file.size || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Usage metadata hash mismatch');
    validateUsageText(file.tool, data.toString('utf8'));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    chmodSync(staged, 0o600);
    utimesSync(staged, file.mtime / 1000, file.mtime / 1000);
    renameSync(staged, destination);
    state[file.relative] = file.sha256;
    bytes += data.length;
    downloaded++;
  }
  writeFileSync(statePath + '.part', JSON.stringify(state), { mode: 0o600 });
  renameSync(statePath + '.part', statePath);
  return { mode: 'usage-metadata', sourceFiles: report.scanned, exportedFiles: report.files.length,
    exportedBytes: report.files.reduce((sum, f) => sum + f.size, 0), downloaded, bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(syncUsage(JSON.parse(readFileSync(process.argv[2], 'utf8'))))); }
  catch (e) { console.error(`Usage sync failed: ${e.status != null ? 'SSH/SFTP status ' + e.status : e.message}`); process.exitCode = 1; }
}
