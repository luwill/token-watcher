import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { normalizeModel } from '../models.js';

const execFileP = promisify(execFile);

/**
 * dsh（DeepSeek Harness）采集器：~/.dsh/sessions 下的 session.jsonl.zstd。
 *
 * - 文件视为原子快照：mtime/size 变化时整体解压重解析，dedup（file+seq）保证幂等。
 * - usage 在 `assistant/chunk` 记录的 data.chunk.usage（Anthropic 口径：input 不含缓存）；
 *   模型来自 `request/header`（顺序解析维护当前模型），cwd 来自 `session` 记录。
 * - 依赖系统 zstd（homebrew / macOS 常见），缺失时整源跳过。
 */
async function decompress(path) {
  try {
    const { stdout } = await execFileP('zstd', ['-dc', path], { maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('zstd not installed');
    throw err;
  }
}

export async function collectDshFile(store, { path, fileId }) {
  let inserted = 0;
  const text = await decompress(path);
  let model = null;
  let project = null;

  for (const line of text.split('\n')) {
    if (!line || (!line.includes('"usage"') && !line.includes('"request/header"') && !line.includes('"type":"session"'))) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'session') {
      project = rec.cwd ? basename(rec.cwd) : project;
      continue;
    }
    if (rec.type === 'request/header') {
      model = rec.data?.header?.config?.model ?? model;
      continue;
    }
    if (rec.type === 'assistant/chunk') {
      const chunk = rec.data?.chunk;
      const u = chunk?.type === 'usage' ? chunk.usage : null;
      if (!u || !Number.isFinite(rec.time)) continue;
      const input = u.inputTokens || 0;
      const cached = u.cacheReadTokens || 0;
      const output = u.outputTokens || 0;
      const total = input + cached + output;
      if (total <= 0) continue;
      inserted += store.insertEvent({
        ts: rec.time,
        tool: 'dsh',
        model: normalizeModel(model),
        session_id: fileId,
        project,
        input_tokens: input,
        cached_input: cached,
        cache_write: 0,
        output_tokens: output,
        reasoning_tokens: u.reasoningTokens || 0,
        total_tokens: total,
        dedup_key: `dsh:${fileId}:${rec.seq}:${rec.data?.turn ?? ''}:${rec.data?.step ?? ''}`,
      });
    }
  }
  return { inserted };
}
