/** Runs on Windows. Export a whitelist of usage metadata, never full sessions. */
import { createHash } from 'node:crypto';
import { createReadStream, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const COUNTS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens',
  'reasoning_output_tokens', 'total_tokens'];
const CLAUDE_COUNTS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
const hash = value => createHash('sha256').update(value).digest('hex');
export function maskedId(domain, value) {
  const h = hash(`${domain}:${typeof value === 'string' ? value : ''}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function modelId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,159}$/i.test(value)
    && !/^(sk-|ghp_|github_pat_|AKIA)/i.test(value) ? value : null;
}
function counts(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const field of fields) {
    if (value[field] === undefined) continue;
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null;
    out[field] = value[field];
  }
  return Object.keys(out).length ? out : null;
}

/** Every output object is built from scratch; no spreads or raw payload passthrough. */
export function projectUsage(tool, record, identity) {
  const time = Date.parse(record?.timestamp);
  if (!Number.isFinite(time)) return null;
  const timestamp = new Date(time).toISOString();
  if (tool === 'claude-code') {
    const msg = record.message;
    if (record.type !== 'assistant' || typeof msg?.id !== 'string') return null;
    const usage = counts(msg.usage, CLAUDE_COUNTS);
    const model = modelId(msg.model);
    if (!usage || !model || msg.model === '<synthetic>') return null;
    const thinking = msg.usage?.output_tokens_details?.thinking_tokens;
    if (Number.isSafeInteger(thinking) && thinking >= 0) usage.output_tokens_details = { thinking_tokens: thinking };
    const out = { type: 'assistant', timestamp,
      sessionId: maskedId('claude-session', record.sessionId || record.session_id || identity),
      cwd: '/windows-office',
      message: { id: maskedId('claude-message', msg.id), model, usage } };
    if (typeof record.requestId === 'string') out.requestId = maskedId('claude-request', record.requestId);
    return out;
  }
  if (tool !== 'codex') return null;
  const p = record.payload;
  const type = p?.type || record.type;
  if (record.type === 'compacted') return { type: 'compacted', timestamp };
  if (!p || typeof p !== 'object') return null;
  if (record.type === 'session_meta' || type === 'session_meta') {
    const payload = { cwd: '/windows-office' };
    if (typeof p.parent_thread_id === 'string') payload.parent_thread_id = maskedId('codex-session', p.parent_thread_id);
    return { type: 'session_meta', timestamp, payload };
  }
  if (record.type === 'turn_context') {
    const model = modelId(p.model);
    return model ? { type: 'turn_context', timestamp, payload: { model } } : null;
  }
  if (type === 'thread_settings_applied') {
    const model = modelId(p.thread_settings?.model);
    return model ? { type: 'event_msg', timestamp,
      payload: { type, thread_settings: { model } } } : null;
  }
  if (record.type === 'token_usage_record') {
    const usage = counts(p.usage, COUNTS);
    if (!usage || typeof p.response_id !== 'string') return null;
    const payload = { usage, response_id: maskedId('codex-response', p.response_id) };
    if (typeof p.session_id === 'string') payload.session_id = maskedId('codex-session', p.session_id);
    return { type: 'token_usage_record', timestamp, payload };
  }
  if (type === 'token_count') {
    const total = counts(p.info?.total_token_usage, COUNTS);
    if (!total) return null;
    const info = { total_token_usage: total };
    const last = counts(p.info?.last_token_usage, COUNTS);
    if (last) info.last_token_usage = last;
    const payload = { type: 'token_count', info };
    if (typeof p.session_id === 'string') payload.session_id = maskedId('codex-session', p.session_id);
    return { type: 'event_msg', timestamp, payload };
  }
  // Timing only: preserves the existing collector's fork/replay detection; no tool name/arguments/output.
  if (record.type === 'response_item' && type === 'function_call') {
    return { type: 'response_item', timestamp, payload: { type: 'function_call' } };
  }
  return null;
}

async function* completeLines(path) {
  let rest = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let start = 0, end;
    while ((end = data.indexOf(10, start)) !== -1) {
      yield data.subarray(start, end).toString('utf8');
      start = end + 1;
    }
    rest = data.subarray(start);
  }
  // A currently-written partial line must wait until the next run.
}
function* walk(root) {
  if (!existsSync(root)) return;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const path = join(root, e.name);
    if (e.isDirectory()) yield* walk(path);
    else if (e.isFile() && !e.name.includes('.sync-conflict-') && !/ \(\d+\)\.[^.]+$/.test(e.name)) {
      if (/\.jsonl(?:\.(?:zst|zstd))?$/i.test(e.name)) yield path;
    }
  }
}
async function digestFile(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

export async function exportUsage({ home = homedir(), output = join(home, '.tokenmeter', 'windows-usage-export') } = {}) {
  const roots = [
    { tool: 'claude-code', bucket: 'claude/projects', path: join(home, '.claude', 'projects') },
    { tool: 'codex', bucket: 'codex/sessions', path: join(home, '.codex', 'sessions') },
    { tool: 'codex', bucket: 'codex/sessions', path: join(home, '.codex', 'archived_sessions') },
  ];
  mkdirSync(output, { recursive: true });
  const indexPath = join(output, 'state.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { version: 1, sources: {} };
  if (index.version !== 1 || !index.sources) throw new Error('Invalid export state');
  const files = new Map();
  let scanned = 0, changed = 0, unsupported = 0, rewrites = 0;
  for (const root of roots) for (const source of walk(root.path)) {
    scanned++;
    if (!source.endsWith('.jsonl')) { unsupported++; continue; }
    const stem = basename(source, '.jsonl');
    const identity = root.tool === 'codex' ? (stem.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i)?.[0] || stem) : source;
    const id = maskedId(root.tool === 'codex' ? 'codex-session' : 'claude-file', identity);
    const relative = `${root.bucket}/usage-${id}.jsonl`;
    const destination = join(output, 'usage', relative);
    const info = statSync(source);
    const previous = index.sources[source];
    let digest = existsSync(destination) ? await digestFile(destination) : null;
    let records = previous?.records || 0;
    if (!previous || previous.size !== info.size || previous.mtime !== info.mtimeMs || !digest) {
      mkdirSync(dirname(destination), { recursive: true });
      const temp = `${destination}.part`;
      const fd = openSync(temp, 'w', 0o600);
      const oldSize = existsSync(destination) ? statSync(destination).size : 0;
      const fullHash = createHash('sha256'), prefixHash = createHash('sha256');
      let bytes = 0;
      records = 0;
      try {
        for await (const line of completeLines(source)) {
          let raw;
          try { raw = JSON.parse(line); } catch { continue; }
          const projected = projectUsage(root.tool, raw, identity);
          if (!projected) continue;
          const encoded = Buffer.from(JSON.stringify(projected) + '\n');
          if (bytes < oldSize) prefixHash.update(encoded.subarray(0, oldSize - bytes));
          fullHash.update(encoded);
          writeSync(fd, encoded);
          bytes += encoded.length;
          records++;
        }
      } finally { closeSync(fd); }
      const nextHash = fullHash.digest('hex');
      if (oldSize && (bytes < oldSize || prefixHash.digest('hex') !== digest)) {
        // JSONL must remain an append-only prefix for the existing incremental collectors.
        rewrites++;
        continue;
      }
      if (nextHash !== digest) { renameSync(temp, destination); changed++; }
      digest = nextHash;
      // Store pre-read metadata: changes during a read must cause a retry next time.
      index.sources[source] = { size: info.size, mtime: info.mtimeMs, records };
    }
    if (!existsSync(destination)) continue;
    const s = statSync(destination);
    files.set(relative, { tool: root.tool, relative,
      remote: '/' + resolve(destination).replaceAll('\\', '/'),
      size: s.size, mtime: Math.trunc(s.mtimeMs), sha256: digest, records });
  }
  writeFileSync(indexPath + '.part', JSON.stringify(index), { mode: 0o600 });
  renameSync(indexPath + '.part', indexPath);
  return { version: 1, mode: 'usage-metadata', scanned, changed, unsupported, rewrites, files: [...files.values()] };
}

if (process.argv.includes('--export')) {
  try { console.log(JSON.stringify(await exportUsage())); }
  catch { console.error('Usage export failed; original logs and credentials were not transferred.'); process.exitCode = 1; }
}
