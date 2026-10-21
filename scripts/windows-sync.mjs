#!/usr/bin/env node
/** Incremental Windows -> Mac SFTP mirror. No SQLite access or file deletion. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = {
  'claude/projects': '.claude/projects',
  'codex/sessions': '.codex/sessions',
  'codex/archived_sessions': '.codex/archived_sessions',
};

export function quoteSftp(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Control character in file path');
  // OpenSSH sftp already makes glob characters literal inside double quotes.
  return '"' + value.replace(/[\\"]/g, '\\$&') + '"';
}

export function validateManifest(manifest) {
  if (manifest?.version !== 1 || !/^\/[A-Za-z]:\//.test(manifest.home)
    || /[\x00-\x1f\\]/.test(manifest.home) || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.roots) || manifest.roots.some(r => !Object.hasOwn(ROOTS, r))) {
    throw new Error('Invalid Windows log manifest');
  }
  const keys = new Set();
  return manifest.files.map(file => {
    const rel = file.relative;
    if (!Object.hasOwn(ROOTS, file.bucket) || typeof rel !== 'string' || !rel
      || rel.split('/').some(s => !s || s === '.' || s === '..')
      || /[\x00-\x1f\\:]/.test(rel)
      || !(file.bucket.startsWith('codex/') ? /\.jsonl(?:\.zst|\.zstd)?$/i : /\.jsonl$/i).test(rel)
      || file.remote !== `${manifest.home}/${ROOTS[file.bucket]}/${rel}`
      || !Number.isSafeInteger(file.size) || file.size < 0
      || !Number.isSafeInteger(file.mtime) || file.mtime < 0) {
      throw new Error('Manifest contains a file outside allowed log roots');
    }
    quoteSftp(file.remote);
    const key = `${file.bucket}/${rel}`;
    if (keys.has(key)) throw new Error('Duplicate manifest path');
    keys.add(key);
    return { ...file, key };
  });
}

function ensureDirectory(path) {
  if (existsSync(path)) {
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Mirror directory is not a real directory');
    return;
  }
  ensureDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
}

function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.part`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

export function syncWindows(config, { exec = execFileSync } = {}) {
  if (config.mode !== 'full-session-mirror') throw new Error('Full-session mirroring is disabled unless explicitly configured');
  if (!/^[A-Za-z0-9_.-]+@[0-9.]+$/.test(config.target)
    || !/^[A-Za-z0-9]+$/.test(config.interface)
    || ![config.identityFile, config.knownHostsFile, config.mirrorRoot].every(p => typeof p === 'string' && isAbsolute(p))) {
    throw new Error('Config requires user@IPv4, a network interface, and absolute local paths');
  }
  for (const p of [config.identityFile, config.knownHostsFile]) {
    if (!existsSync(p)) throw new Error('Dedicated SSH identity or verified known_hosts is missing');
  }
  const options = [
    '-F', '/dev/null', '-i', config.identityFile,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${config.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-o', `ProxyCommand=/usr/bin/nc -4 -b ${config.interface} -G 8 %h %p`,
  ];
  const script = readFileSync(join(import.meta.dirname, 'windows-sync-manifest.ps1'), 'utf8');
  const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  const getManifest = () => {
    const raw = exec('/usr/bin/ssh', [...options, config.target, command], {
      encoding: 'utf8', timeout: 45_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const manifest = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
    return { manifest, files: validateManifest(manifest) };
  };
  const { manifest, files } = getManifest(); // No local changes until SSH + parsing succeeds.
  const root = resolve(config.mirrorRoot);
  ensureDirectory(root);
  const statePath = join(root, '.sync-state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { version: 1, files: {} };
  if (state.version !== 1 || !state.files || typeof state.files !== 'object') throw new Error('Invalid local sync state');
  const selected = files.filter(file => {
    const path = join(root, file.key);
    const old = state.files[file.key];
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Refusing a symbolic link in mirror');
    return !old || old.remote !== file.remote || old.size !== file.size || old.mtime !== file.mtime
      || !existsSync(path) || statSync(path).size !== file.size;
  });
  if (!selected.length) return { discovered: files.length, downloaded: 0, pending: 0, roots: manifest.roots };
  const staging = join(root, '.staging');
  ensureDirectory(staging);
  const batch = [];
  for (const file of selected) {
    file.staged = join(staging, `${createHash('sha256').update(file.key).digest('hex')}.${process.pid}.part`);
    batch.push(`get -p ${quoteSftp(file.remote)} ${quoteSftp(file.staged)}`);
  }
  // Batch failure leaves the previous mirrors and cursor unchanged. Partial downloads remain outside scanned roots.
  exec('/usr/bin/sftp', [...options, '-b', '-', config.target], {
    input: batch.join('\n') + '\n', encoding: 'utf8', timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const after = new Map(getManifest().files.map(file => [file.key, file]));
  let downloaded = 0;
  for (const file of selected) {
    const current = after.get(file.key);
    if (!current || current.remote !== file.remote || current.size !== file.size || current.mtime !== file.mtime
      || !existsSync(file.staged) || statSync(file.staged).size !== file.size) continue;
    const destination = join(root, file.key);
    ensureDirectory(dirname(destination));
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new Error('Refusing a symbolic link in mirror');
    utimesSync(file.staged, file.mtime / 1000, file.mtime / 1000);
    renameSync(file.staged, destination);
    state.files[file.key] = { remote: file.remote, size: file.size, mtime: file.mtime };
    downloaded++;
  }
  state.lastSuccess = new Date().toISOString();
  atomicJson(statePath, state);
  return { discovered: files.length, downloaded, pending: selected.length - downloaded, roots: manifest.roots };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node windows-sync.mjs /absolute/path/windows-sync.json');
    const result = syncWindows(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(`${new Date().toISOString()} ${JSON.stringify(result)}`);
    if (!result.roots.length) process.exitCode = 2;
  } catch (error) {
    // SSH stderr may include private paths. Print a bounded cause without sessions or filenames.
    const stderr = String(error.stderr ?? '');
    const detail = /Host key verification failed|No ED25519 host key is known/.test(stderr) ? 'Verify Windows host key first'
      : /Permission denied/.test(stderr) ? 'SSH public key authorization failed'
      : /timed out|timeout/i.test(stderr) || error.code === 'ETIMEDOUT' ? 'LAN SSH connection timed out'
      : error.status != null ? `SSH/SFTP exited with status ${error.status}` : error.message;
    console.error(`${new Date().toISOString()} Windows sync failed: ${detail}`);
    process.exitCode = 1;
  }
}
