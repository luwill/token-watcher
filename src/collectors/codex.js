import { basename } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';
import { quotaFromRateLimits } from '../codexQuota.js';
import { nextUsage, usageSnapshot } from '../codexUsage.js';

/**
 * Codex rollout 采集器（~/.codex/sessions 与 archived_sessions，2.4GB 量级）。
 *
 * - 单次用量取 token_count.info.last_token_usage；total_token_usage（累计值）只用来认
 *   重复通知与交错的累计流，规则见 codexUsage.js。
 * - 模型名（版本差异，两种都认）：新格式 thread_settings_applied.thread_settings.model；
 *   旧格式 turn_context.payload.model（2026-09 之前的 rollout）。
 * - 工具调用：response_item 且 payload.type=function_call（name/call_id）。
 * - rate_limits 为账号级配额快照：只保留全局最新一条（按 ts）；窗口识别与过滤见 codexQuota.js。
 * - 增量恢复：state（累计值 + 当前模型 + 项目 + 重放窗口）持久化在 files.state_json。
 * - OpenAI 口径：input_tokens 已含 cached_input_tokens，total = input + output。
 * - 开头重放：子代理 / 分叉 / 审查代理的文件在创建那一刻把父会话历史整段写进开头，
 *   那些请求父文件里已经计过。识别与阈值见 REPLAY_GAP_MS。
 * - 上下文压缩：压缩调用的用量只写在 token_usage_record 里（CLI 0.151 起），后面紧跟一行
 *   compacted；随后的 token_count 累计值不动，last 回报的是压缩后的上下文大小。
 *   其余 token_usage_record 与 token_count 说的是同一次请求，不另计。
 */

/**
 * 重放段内相邻两行的最大间隔。重放是一次性落盘，每行盖的是落盘时刻：
 * 698 个真实 rollout 里段内相邻行最多差 53ms，而真实请求要等模型返回，
 * 离会话创建最少 2135ms——阈值两侧各留 4 倍以上余量。
 * 判不准时一律当真实请求计入：漏掉真实用量比多算一段重放更糟。
 */
const REPLAY_GAP_MS = 500;

/**
 * 这一行是否仍属于文件开头的重放段。st.replay 是窗口锚点：
 * undefined = 还没见到首行；数字 = 窗口开着（上一条重放行的时刻）；null = 已关闭，不再重开。
 */
function inReplay(st, ts) {
  if (st.replay == null) return false;
  if (Number.isFinite(ts) && ts >= st.replay && ts - st.replay < REPLAY_GAP_MS) {
    st.replay = ts;
    return true;
  }
  st.replay = null; // 首个明显间隔（或时钟回拨）之后都是真实活动
  return false;
}

export async function collectCodexFile(store, { path, fileId, offset, state, version }) {
  let st = state ?? { model: null, heads: [], project: null, seq: 0, parent: null };
  st._v = version; // 版本戳：避免常驻服务每轮全量重扫
  let inserted = 0;
  // 从头重扫（首次见到、采集器升级）：先清掉这个文件按旧规则入库的行再重建。
  // 与本次采集同在扫描器的一个事务里，解析失败会一并回滚。
  if (!state && offset === 0) store.dropStaleCodexRows(fileId, path, version);

  const insert = (ts, d, sessionId, dedupKey) => store.insertEvent({
    ts,
    tool: 'codex',
    model: st.model,
    session_id: sessionId || fileId,
    project: st.project,
    input_tokens: Math.max(d.i - d.c, 0), // 新输入 = input - 缓存命中
    cached_input: Math.max(d.c, 0),
    cache_write: Math.max(d.w, 0),
    output_tokens: Math.max(d.o, 0),
    reasoning_tokens: Math.max(d.r, 0),
    total_tokens: d.i > 0 ? d.i + d.o : Math.max(d.tt, 0),
    dedup_key: dedupKey,
  });

  const { newOffset } = await readLinesFrom(path, offset, (line) => {
    // 刚记下的用量记录是不是压缩调用，只看紧跟的这一行
    if (st.record && !st.record.compacted) {
      if (line.includes('"type":"compacted"')) { st.record.compacted = true; return; }
      st.record = null;
    }
    if (!line.includes('"token_count"') &&
        !line.includes('"token_usage_record"') &&
        !line.includes('"thread_settings_applied"') &&
        !line.includes('"session_meta"') &&
        !line.includes('"turn_context"') &&
        !line.includes('"function_call"')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const payload = rec?.payload;
    if (!payload) return;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;

    if (rec.type === 'token_usage_record') {
      // 没有 response_id 就没法跨文件去重，不记
      if (payload.usage && payload.response_id && Number.isFinite(ts)) {
        st.record = { ts, id: payload.response_id, usage: usageSnapshot(payload.usage), sid: payload.session_id ?? null, compacted: false };
      }
      return;
    }

    const isMeta = rec.type === 'session_meta' || payload.type === 'session_meta';
    // 窗口只在文件首行是 session_meta 时打开：没有可靠锚点就不猜
    if (st.replay === undefined) st.replay = isMeta && Number.isFinite(ts) ? ts : null;

    if (isMeta) {
      // session_meta 的 type 在记录顶层，payload 即 SessionMeta（含 cwd）
      st.project = payload.cwd ? basename(payload.cwd) : st.project;
      st.parent = payload.parent_thread_id || null; // resume 链：模型可从父会话继承
      return;
    }
    if (rec.type === 'turn_context') {
      if (payload.model) st.model = normalizeModel(payload.model); // 旧格式模型位
      return;
    }
    if (rec.type === 'response_item' && payload.type === 'function_call') {
      if (inReplay(st, ts)) return; // 父会话的工具调用，父文件里已经计过
      if (payload.name && Number.isFinite(ts)) {
        store.insertToolCall({
          ts, tool: 'codex', name: payload.name,
          session_id: fileId,
          dedup_key: `codex:tc:${path}:${payload.call_id ?? `${st.seq}`}`,
        });
      }
      return;
    }
    if (payload.type === 'thread_settings_applied') {
      st.model = normalizeModel(payload.thread_settings?.model ?? st.model);
      return;
    }
    if (payload.type === 'token_count') {
      const info = payload.info;
      if (!info?.total_token_usage || !Number.isFinite(ts)) return;
      const replayed = inReplay(st, ts);

      // 重放行的配额是父会话当年的快照，却盖着分叉时刻：按 ts 取最新会把它当成当前值
      const quota = replayed ? null : quotaFromRateLimits(payload.rate_limits);
      if (quota) store.saveQuota('codex', ts, quota);

      const compaction = st.record?.compacted ? st.record : null;
      st.record = null;
      const { usage: d, heads } = nextUsage(st.heads, info.total_token_usage, info.last_token_usage);
      st.heads = heads; // 重放行也推进累计值：之后的真实请求要接着它认
      if (replayed) return;
      if (!d) {
        // 累计值没动又紧跟压缩记录：这次请求只在记录里。response_id 全局唯一，重扫与副本都幂等
        if (compaction) inserted += insert(compaction.ts, compaction.usage, compaction.sid, `codex:resp:${compaction.id}`);
        return;
      }
      if (d.i <= 0 && d.o <= 0 && d.tt <= 0) return; // 无新用量

      st.seq++;
      // 文件内单调序号，重放幂等
      inserted += insert(ts, d, payload.session_id, `codex:${path}:${st.seq}`);
    }
  });

  return { newOffset, inserted, state: st };
}
