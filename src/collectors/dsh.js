import { basename } from 'node:path';
import { normalizeModel } from '../models.js';
import { decompressZstd } from '../zstd.js';

/**
 * DSH 会把本地 CLI agent（codex / antigravity / claude code / opencode / grok …）包成一个
 * 会话，provider 形如 `local-codex-cli`、`local-antigravity`。这些 turn 的用量已经由该
 * CLI 自己的采集器上报（codex / antigravity / claude / opencode / grok），这里再记一遍
 * 就是整份重复：同一批 token 在 events 里出现两行，一行 tool=dsh、模型名是 CLI 的模型。
 * 实测 2026-11-23 一天，重复量占上报总量的 42.1%。
 *
 * 判据用 provider 前缀：DSH 侧原生的 provider 是 `magpie`、`magpie-responses`、
 * `deepseek-account` 这类普通名字，只有被包裹的 CLI agent 才带 `local-` 前缀。
 */
const isWrappedCliProvider = provider =>
  typeof provider === 'string' && provider.startsWith('local-');

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
export async function collectDshFile(store, { path, fileId }) {
  let inserted = 0;
  const text = (await decompressZstd(path)).toString('utf8');
  // seq 标识日志行，不是请求：同一次请求会有 chunk、message 两行，v3 副本还会
  // 重排 seq。turn + step 在同一会话内才是请求身份，不能靠时间戳或用量猜测重复。
  const file = basename(path);
  const requests = new Map();
  let model = null;
  let provider = null;
  let project = null;

  const record = (rec, u, legacyKey, recModel, recProvider) => {
    if (!u || !Number.isFinite(rec.time)) return;
    // 被包裹的 CLI agent：用量归各自的 CLI 采集器，这里跳过。
    if (isWrappedCliProvider(recProvider ?? provider)) return;
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
      provider = rec.data?.header?.config?.provider ?? provider;
      continue;
    }
    if (rec.type === 'assistant/message') {
      record(rec, rec.data?.usage, `dsh:${fileId}:${file}:${rec.seq}`,
        rec.data?.message?.source?.model, rec.data?.message?.source?.provider);
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
