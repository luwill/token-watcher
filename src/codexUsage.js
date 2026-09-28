/**
 * Codex token_count → 单次请求用量。
 *
 * 每条 token_count 带两个量：last_token_usage 是这一次请求的用量，
 * total_token_usage 是所在累计流到此为止的总和（Codex 保证 total = 上一条 total + last）。
 * 单次用量直接取 last；累计值只用来认"这条是不是已经见过"。
 * 早期 rollout 没有 last_token_usage，只能对上一条累计值差分。
 */
const FIELDS = ['i', 'c', 'w', 'o', 'r', 'tt'];

export function usageSnapshot(u) {
  return {
    i: u.input_tokens || 0,
    c: u.cached_input_tokens || 0,
    w: u.cache_write_input_tokens || 0,
    o: u.output_tokens || 0,
    r: u.reasoning_output_tokens || 0,
    tt: u.total_tokens || 0,
  };
}

const minus = (a, b) => Object.fromEntries(FIELDS.map(k => [k, a[k] - b[k]]));
const same = (a, b) => FIELDS.every(k => a[k] === b[k]);

/**
 * 一个 rollout 里可能交错着几条累计流（主代理 + 内嵌的审查代理，各有各的累计值），
 * 行上没有流的标识，只能靠累计值认。每条流记一个最新累计值，最近用过的在末尾。
 * 被挤掉的流只是认不出它的重复通知，单次用量仍取 last，不会算错。
 */
const MAX_HEADS = 8;
const advance = (heads, dropIdx, cur) => [...heads.filter((_, i) => i !== dropIdx), cur].slice(-MAX_HEADS);

/**
 * 消化一条 token_count。heads 是各条流的最新累计值，不会被改动。
 * 返回 { usage, heads }：usage 为本次请求用量，null 表示这条不产生用量。
 */
export function nextUsage(heads, total, last) {
  const cur = usageSnapshot(total);
  const seen = heads.findIndex(h => same(h, cur));
  // 累计值没动 = 重复通知（配额刷新、压缩后的上下文回报），不是一次请求
  if (seen >= 0) return { usage: null, heads: advance(heads, seen, cur) };
  if (last) {
    const usage = usageSnapshot(last);
    // total - last 等于哪条流的上一个累计值，这条就接在哪条流后面；
    // 都对不上就是一条新流，或会话恢复后计数器从零重新开始
    const prev = minus(cur, usage);
    return { usage, heads: advance(heads, heads.findIndex(h => same(h, prev)), cur) };
  }
  // 无 last_token_usage 的早期格式：对上一条累计值差分，首条只建立基线
  const active = heads.at(-1);
  return { usage: active ? minus(cur, active) : null, heads: advance(heads, heads.length - 1, cur) };
}
