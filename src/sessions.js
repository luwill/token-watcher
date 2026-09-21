import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * token-watcher sessions：会话级统计的 CLI 出口（面板"会话钻取"的同款 SQL）。
 *
 * 支持 --day（单日）或 --from/--to（区间，YYYY-MM-DD，含端点）；
 * --git 给每个会话挂上"会话窗口内的 git 提交"（产出归因）：
 *   - cwd 从源文件首段取（Claude transcript 的 rec.cwd / Codex session_meta.payload.cwd），
 *     events 表只存目录名，反推不唯一，不能拿来做归因；
 *   - 窗口 = [first_ts, last_ts + 30min]（生成结束后落提交的常见滞后）；
 *   - 只读 git log，fail-soft：非 git 目录 / git 缺失一律 commits=null。
 */

export function buildSessions(db, { day = null, from = null, to = null } = {}) {
  const SELECT = `
      SELECT session_id, tool, MIN(ts) first_ts, MAX(ts) last_ts, COUNT(*) calls,
             SUM(total_tokens) total, MAX(total_tokens) peak, MAX(project) project,
             GROUP_CONCAT(DISTINCT model) models
      FROM events`;
  if (day) {
    return db.prepare(`${SELECT}
      WHERE date(ts/1000, 'unixepoch', 'localtime') = ?
      GROUP BY session_id ORDER BY total DESC LIMIT 500`).all(day);
  }
  if (from && to) {
    // 区间按"会话首末事件的本地日"裁剪（与会话钻取的 localtime 口径一致）
    return db.prepare(`SELECT * FROM (${SELECT} GROUP BY session_id)
      WHERE date(first_ts/1000, 'unixepoch', 'localtime') >= ?
        AND date(last_ts/1000, 'unixepoch', 'localtime') <= ?
      ORDER BY total DESC LIMIT 500`).all(from, to);
  }
  return db.prepare(`${SELECT} GROUP BY session_id ORDER BY total DESC LIMIT 500`).all();
}

const csvEsc = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;

export function sessionsToCsv(sessions) {
  const head = 'session_id,tool,project,first_ts,last_ts,calls,total_tokens,peak_tokens,models,commits';
  const line = (s) => [
    s.session_id, s.tool, s.project ?? '',
    new Date(s.first_ts).toISOString(), new Date(s.last_ts).toISOString(),
    s.calls, s.total, s.peak, s.models ?? '',
    s.commits != null ? s.commits : '',
  ].map(csvEsc).join(',');
  return [head, ...sessions.map(line)].join('\n') + '\n';
}

/** 从会话对应的源文件首段提取 cwd（events.project 只存目录名，不够归因用） */
async function resolveCwd(db, session) {
  let path = null;
  if (session.tool === 'claude-code' || session.tool === 'ccmr') {
    path = db.prepare('SELECT path FROM files WHERE session_id = ? AND tool = ? LIMIT 1')
      .get(session.session_id, session.tool)?.path;
  } else if (session.tool === 'codex') {
    // events 的 session_id 是 thread id；files 的 session_id 是文件 stem（rollout-…-<uuid>）
    path = db.prepare('SELECT path FROM files WHERE tool = ? AND session_id = ? LIMIT 1')
      .get('codex', session.session_id)?.path
      ?? db.prepare("SELECT path FROM files WHERE tool = 'codex' AND session_id LIKE '%-' || ? LIMIT 1")
        .get(session.session_id)?.path;
  }
  if (!path) return null;
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(262_144); // cwd 出现在文件头部的 session 元信息里，256KB 足够
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const m = buf.toString('utf8', 0, bytesRead).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!m) return null;
      return JSON.parse(`"${m[1]}"`);
    } finally {
      await fh.close();
    }
  } catch { return null; }
}

async function gitLog(cwd, sinceMs, untilMs, { execImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execImpl('git', ['-C', cwd, 'log', '--no-merges', '-n', '100',
      `--since=${new Date(sinceMs).toISOString()}`,
      `--until=${new Date(untilMs).toISOString()}`,
      '--pretty=%h%x1f%aI%x1f%s'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim() ? stdout.trim().split('\n').map(l => {
      const [hash, ts, subject] = l.split('\x1f');
      return { hash, ts, subject };
    }) : [];
  } catch { return null; } // 非 git 目录 / git 未装 / 超时
}

const GIT_TAIL_MS = 30 * 60_000; // 生成结束 → 用户确认落提交的常见滞后

/** 给会话列表挂 commits（数量与明细）。源不支持 cwd 的会话 commits 保持 null（诚实缺省）。 */
export async function attachGitOutcomes(db, sessions, { execImpl } = {}) {
  for (const s of sessions) {
    if (!['claude-code', 'ccmr', 'codex'].includes(s.tool)) continue;
    const cwd = await resolveCwd(db, s);
    if (!cwd) continue;
    const commits = await gitLog(cwd, s.first_ts, s.last_ts + GIT_TAIL_MS, { execImpl });
    if (commits) s.commits = commits.length, s.commit_list = commits.slice(0, 20);
  }
  return sessions;
}
