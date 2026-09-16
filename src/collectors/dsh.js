import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import zlib from 'node:zlib';
import { normalizeModel } from '../models.js';

const execFileP = promisify(execFile);

// 回落用的候选路径：不能只靠 PATH。常驻服务由 launchd 拉起，其 PATH 是系统默认，
// 不含 /opt/homebrew/bin，而 zstd 通常只装在那里。
const ZSTD_BINS = ['zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd'];

/**
 * dsh（DeepSeek Harness）采集器：~/.dsh/sessions 下 zstd 压缩的会话快照。
 *
 * - 文件视为原子快照：mtime/size 变化时整体解压重解析，dedup 保证幂等。
 * - 两种记录结构并存，必须都认：
 *     旧（session.jsonl.zstd）    type=assistant/chunk，用量在 data.chunk.usage
 *     v3（session.v3.jsonl.zstd） type=assistant/message，用量在 data.usage
 *   2026-08-14 dsh 切到 v3，本采集器当时只认旧结构，打开文件后一条也匹配不上、
 *   返回 0 且不报错，整源静默归零一个月。字段名两边一致，仅类型名与路径变了。
 * - 用量口径（两种结构相同）：input 不含缓存，reasoning 已含在 output 内，
 *   total = input + cacheRead + cacheWrite + output（v3 自带 totalTokens，实测恒等）。
 * - 模型优先取记录自带的 data.message.source.model（v3 起每条都带），
 *   回落到顺序解析 request/header 维护的当前模型；cwd 来自 session 记录。
 * - 解压优先用 Node 内置 zstd，旧版 Node 回落到外部 zstd（含常见绝对路径），都没有则整源跳过。
 */
/** zstd 帧魔数。dsh 按批追加独立帧，单个会话文件实测有数千帧 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解压 zstd。**必须完整支持多帧**：dsh 是追加式写入，每批记录压成一个独立帧接在
 * 文件末尾，实测单个会话文件有 5800+ 帧，CLI 解出 19MB 而只解首帧只有 226 字节。
 *
 * Node 内置的 zstdDecompressSync 与 createZstdDecompress 都只解第一帧就结束，
 * 且不报错——用它做主路径会让整源静默归零（1.4.1/1.4.2 就是这么坏的）。
 * 因此以外部 zstd 为准，并显式试几个常见绝对路径：launchd 的 PATH 是系统默认，
 * 不含 homebrew，这是当初改用内置实现的起因。
 *
 * 只有确认文件仅含单帧时才回落到内置实现。宁可大声失败，也不要悄悄少算。
 */
async function decompress(path) {
  for (const bin of ZSTD_BINS) {
    try {
      const { stdout } = await execFileP(bin, ['-dc', path], { maxBuffer: 1024 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // 真正的解压失败要抛出去，不能当成"没装"
    }
  }
  if (typeof zlib.zstdDecompressSync === 'function') {
    const buf = await readFile(path);
    // 魔数可能在压缩数据里偶然出现，所以这个判定只会高估帧数——方向是安全的：
    // 判成多帧最多是多要求一次外部 zstd，绝不会把多帧文件当单帧而截断。
    if (buf.indexOf(ZSTD_MAGIC, 1) === -1) return zlib.zstdDecompressSync(buf).toString('utf8');
    throw new Error(`${path} 含多个 zstd 帧，Node 内置实现只能解第一帧。请安装 zstd：brew install zstd`);
  }
  throw new Error('zstd 不可用：PATH 与常见安装路径下均无 zstd，请执行 brew install zstd');
}

export async function collectDshFile(store, { path, fileId }) {
  let inserted = 0;
  const text = await decompress(path);
  // fileId 是父目录名。v3 迁移期新旧两个文件会并存于同一目录，若共用 dedup_key
  // 命名空间，seq 相同的两条会互相顶掉，因此 v3 的键额外带上文件名。
  // 旧结构的键保持原样，避免历史事件在重扫时被当成新行插一遍。
  const file = basename(path);
  let model = null;
  let project = null;

  const record = (rec, u, dedupKey, recModel) => {
    if (!u || !Number.isFinite(rec.time)) return;
    const input = u.inputTokens || 0;
    const cached = u.cacheReadTokens || 0;
    const cacheWrite = u.cacheWriteTokens || 0;
    const output = u.outputTokens || 0;
    const total = input + cached + cacheWrite + output;
    if (total <= 0) return;
    inserted += store.insertEvent({
      ts: rec.time,
      tool: 'dsh',
      model: normalizeModel(recModel ?? model),
      session_id: fileId,
      project,
      input_tokens: input,
      cached_input: cached,
      cache_write: cacheWrite,
      output_tokens: output,
      reasoning_tokens: u.reasoningTokens || 0,
      total_tokens: total,
      dedup_key: dedupKey,
    });
  };

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
    if (rec.type === 'assistant/message') {
      record(rec, rec.data?.usage, `dsh:${fileId}:${file}:${rec.seq}`,
        rec.data?.message?.source?.model);
      continue;
    }
    if (rec.type === 'assistant/chunk') {
      const chunk = rec.data?.chunk;
      record(rec, chunk?.type === 'usage' ? chunk.usage : null,
        `dsh:${fileId}:${rec.seq}:${rec.data?.turn ?? ''}:${rec.data?.step ?? ''}`);
    }
  }
  return { inserted };
}
