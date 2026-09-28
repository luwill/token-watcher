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
 * - 同一请求的 chunk、message 与新旧文件副本共用去重键：session + turn + step + 输入侧用量。
 * - 解压优先用外部 zstd（支持追加的多帧），仅单帧时可回落到 Node 内置实现。
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
    // 魔数可能只是压缩负载里的巧合（Windows CI 上真实发生过：夹具解出的压缩字节里
    // 碰巧含帧魔数，被当成多帧后整源拒绝）。只有"以该位置为界、前缀本身能完整解压"
    // 才是真帧边界——真多帧文件的第一帧必然完整，截断的帧必然解压失败。
    let multi = false;
    let idx = buf.indexOf(ZSTD_MAGIC, 1);
    while (idx !== -1) {
      try { zlib.zstdDecompressSync(buf.subarray(0, idx)); multi = true; break; } catch { /* 巧合魔数，继续找 */ }
      idx = buf.indexOf(ZSTD_MAGIC, idx + 1);
    }
    if (!multi) return zlib.zstdDecompressSync(buf).toString('utf8');
    throw new Error(`${path} 含多个 zstd 帧，Node 内置实现只能解第一帧。请安装 zstd：brew install zstd`);
  }
  throw new Error('zstd 不可用：PATH 与常见安装路径下均无 zstd，请执行 brew install zstd');
}

export async function collectDshFile(store, { path, fileId }) {
  let inserted = 0;
  const text = await decompress(path);
  // seq 标识日志行，不是请求：同一次请求会有 chunk、message 两行，v3 副本还会
  // 重排 seq。turn + step 在同一会话内才是请求身份，不能靠时间戳或用量猜测重复。
  const file = basename(path);
  const requests = new Map();
  let model = null;
  let project = null;

  const record = (rec, u, legacyKey, recModel) => {
    if (!u || !Number.isFinite(rec.time)) return;
    const input = u.inputTokens || 0;
    const cached = u.cacheReadTokens || 0;
    const cacheWrite = u.cacheWriteTokens || 0;
    const output = u.outputTokens || 0;
    const total = input + cached + cacheWrite + output;
    if (total <= 0) return;
    const { turn, step } = rec.data;
    const identified = Number.isSafeInteger(turn) && turn >= 0 && Number.isSafeInteger(step) && step >= 0;
    // 无请求身份的旧格式保持原键，不能把 undefined/undefined 的所有请求合成一条。
    // 键里带上输入侧用量：同一请求的各份副本输入必然相同（流式只会让输出增长），
    // 输入不同就是两次请求（如失败后重试）。判不准时宁可各算一次，不静默合并。
    const dedupKey = identified
      ? `dsh:request:${fileId}:${turn}:${step}:${input}:${cached}:${cacheWrite}`
      : legacyKey;
    const event = {
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
    };
    const prev = requests.get(dedupKey);
    const legacyKeys = prev?.legacyKeys ?? new Set();
    // 第二个是 PR #1 合并前的请求键（不含输入用量），只有跑过那个分支的库里才有
    if (identified) legacyKeys.add(legacyKey).add(`dsh:request:${fileId}:${turn}:${step}`);
    // 与 Store 的流式补齐规则一致：保留更完整的输出。用量相同时优先完整消息，
    // 因为它还携带逐请求模型；保留所有旧键，迁移时才能同时清掉 chunk/message。
    if (!prev || output > prev.event.output_tokens ||
        (output === prev.event.output_tokens && rec.type === 'assistant/message')) {
      requests.set(dedupKey, { event, legacyKeys });
    }
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
  for (const { event, legacyKeys } of requests.values()) {
    inserted += store.insertDshEvent(event, legacyKeys);
  }
  return { inserted };
}
