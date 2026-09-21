/**
 * token-wrapped：把一年的本地用量讲成一段可读的"年度报告"。
 * 纯本地聚合（复用 events 表），不出网；--json 给机器可读形状。
 */
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function buildWrapped(db, year) {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  // 按本地时区过滤年份：ts 落在本地年的自然日内。上限 40 万行防御性截断。
  const rows = db.prepare(`
    SELECT ts, tool, model, session_id, project, total_tokens FROM events
    WHERE ts >= ? AND ts < ? AND CAST(strftime('%Y', ts/1000, 'unixepoch', 'localtime') AS INTEGER) = ?
    LIMIT 400000`).all(start - 86_400_000, end + 86_400_000, year);

  let total = 0, events = 0;
  const byTool = new Map(), byModel = new Map(), byProject = new Map();
  const bySession = new Map(), byMonth = new Array(12).fill(0), byHour = new Array(24).fill(0);
  const daySet = new Set();
  let firstDay = null, lastDay = null;

  for (const r of rows) {
    const d = new Date(r.ts);
    total += r.total_tokens; events++;
    byTool.set(r.tool, (byTool.get(r.tool) || 0) + r.total_tokens);
    if (r.model) byModel.set(r.model, (byModel.get(r.model) || 0) + r.total_tokens);
    if (r.project) byProject.set(r.project, (byProject.get(r.project) || 0) + r.total_tokens);
    if (r.session_id) {
      const s = bySession.get(r.session_id) ?? { tool: r.tool, tokens: 0 };
      s.tokens += r.total_tokens;
      bySession.set(r.session_id, s);
    }
    byMonth[d.getMonth()] += r.total_tokens;
    byHour[d.getHours()] += r.total_tokens;
    const k = dayKey(r.ts);
    daySet.add(k);
    if (!firstDay || k < firstDay) firstDay = k;
    if (!lastDay || k > lastDay) lastDay = k;
  }

  // 最长连续使用天数（自然日）
  const days = [...daySet].sort();
  let longest = 0, run = 0, prev = null;
  for (const k of days) {
    if (prev) {
      const gap = (Date.parse(k + 'T00:00:00') - Date.parse(prev + 'T00:00:00')) / 86_400_000;
      run = gap === 1 ? run + 1 : 1;
    } else run = 1;
    longest = Math.max(longest, run);
    prev = k;
  }

  const top = (m, n = 5) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const busiest = days.length
    ? db.prepare(`SELECT date(ts/1000, 'unixepoch', 'localtime') d, SUM(total_tokens) t FROM events
        WHERE CAST(strftime('%Y', ts/1000, 'unixepoch', 'localtime') AS INTEGER) = ?
        GROUP BY d ORDER BY t DESC LIMIT 1`).get(year)
    : null;
  const peakHour = byHour.reduce((best, v, i) => (v > (byHour[best] || 0) ? i : best), 0);
  const biggest = [...bySession.entries()].sort((a, b) => b[1].tokens - a[1].tokens)[0] ?? null;

  return {
    year,
    total_tokens: total,
    events,
    active_days: daySet.size,
    longest_streak_days: longest,
    first_day: firstDay,
    last_day: lastDay,
    busiest_day: busiest ? { day: busiest.d, tokens: busiest.t } : null,
    peak_hour: total > 0 ? peakHour : null,
    top_tools: top(byTool).map(([tool, tokens]) => ({ tool, tokens })),
    top_models: top(byModel).map(([model, tokens]) => ({ model, tokens })),
    top_projects: top(byProject).map(([project, tokens]) => ({ project, tokens })),
    biggest_session: biggest
      ? { session_id: biggest[0], tool: biggest[1].tool, tokens: biggest[1].tokens }
      : null,
    by_month: byMonth,
    by_hour: byHour,
  };
}

const fmt = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};

/** 人类可读报告（等宽对齐，emoji 只做行首标记，管道重定向时不依赖颜色） */
export function renderWrapped(w) {
  const L = [];
  L.push(`┌─ Token Watcher · ${w.year} 年度报告 ─────────────────`);
  if (!w.events) {
    L.push('│  这一年没有本地用量数据。');
    L.push('└──────────────────────────────');
    return L.join('\n');
  }
  const span = w.first_day === w.last_day ? w.first_day : `${w.first_day} → ${w.last_day}`;
  L.push(`│ 全年 ${fmt(w.total_tokens)} tokens / ${w.events.toLocaleString('en-US')} 次请求`);
  L.push(`│ 活跃 ${w.active_days} 天（最长连续 ${w.longest_streak_days} 天）· ${span}`);
  if (w.busiest_day) L.push(`│ 最猛的一天 ${w.busiest_day.day}：${fmt(w.busiest_day.tokens)} tokens`);
  if (w.peak_hour != null) L.push(`│ 高产时段 ${String(w.peak_hour).padStart(2, '0')}:00 前后`);
  L.push('│');
  const bar = (v, max) => '█'.repeat(Math.max(1, Math.round((v / (max || 1)) * 20)));
  for (const t of w.top_tools.slice(0, 3)) {
    L.push(`│ ${t.tool.padEnd(12)} ${fmt(t.tokens).padStart(7)}  ${bar(t.tokens, w.top_tools[0].tokens)}`);
  }
  if (w.top_models.length) L.push(`│ 最常用模型  ${w.top_models[0].model}（${fmt(w.top_models[0].tokens)}）`);
  if (w.biggest_session) L.push(`│ 最大会话    ${w.biggest_session.tool} · ${fmt(w.biggest_session.tokens)} tokens`);
  if (w.top_projects.length) {
    L.push('│ 项目 Top 3');
    for (const p of w.top_projects.slice(0, 3)) L.push(`│   ${p.project.padEnd(20)} ${fmt(p.tokens)}`);
  }
  L.push('│ 月度分布');
  for (let m = 0; m < 12; m++) {
    if (!w.by_month[m]) continue; // 零值月份不显示
    L.push(`│   ${String(m + 1).padStart(2)}月 ${bar(w.by_month[m], Math.max(...w.by_month))} ${fmt(w.by_month[m])}`);
  }
  L.push('└──────────────────────────────');
  return L.join('\n');
}
