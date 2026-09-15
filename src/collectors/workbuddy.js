import { basename, dirname } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';

/**
 * WorkBuddy 采集器：~/.WorkBuddy/projects/<dir>/<session>.jsonl（Electron 版 transcript）。
 *
 * - usage 在记录的 message.usage（OpenAI 口径：input_tokens 已含 cache_read，
 *   实测 total = input + output）；
 * - providerData 携带 model（真实名，如 glm-5.3-flash）与 traceId（轮次键，
 *   供 credit 对账与费率自学习）；
 * - 项目名从目录名解出（...-WorkBuddy-<名称>）。
 */
function projectFromDir(fileDir) {
  const name = basename(fileDir);
  const m = name.match(/-WorkBuddy-(.+)$/);
  return m ? m[1] : name;
}

export async function collectWorkbuddyFile(store, { tool, path, fileId, offset }) {
  let inserted = 0;
  // 用 dirname 而不是 lastIndexOf('/')：Windows 上分隔符是反斜杠，
  // 原写法找不到 '/' 会退化成 slice(0, -1)，把项目名切成文件名的残片
  const project = projectFromDir(dirname(path));

  const { newOffset } = await readLinesFrom(path, offset, (line) => {
    if (!line.includes('"usage"')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const u = rec?.message?.usage;
    if (!u || !rec.id || !Number.isFinite(rec.timestamp)) return;
    const inputRaw = u.input_tokens || 0;
    const cached = Math.min(u.cache_read_input_tokens || 0, inputRaw);
    const output = u.output_tokens || 0;
    if (inputRaw + output <= 0) return;

    const pd = rec.providerData || {};
    inserted += store.insertEvent({
      ts: rec.timestamp,
      tool,
      model: normalizeModel(pd.model),
      session_id: rec.sessionId || fileId,
      project,
      input_tokens: inputRaw - cached,
      cached_input: cached,
      cache_write: 0,
      output_tokens: output,
      reasoning_tokens: 0,
      total_tokens: inputRaw + output,
      dedup_key: `wb:${rec.id}`,
      trace_id: pd.traceId || null,
    });
  });

  return { newOffset, inserted };
}
