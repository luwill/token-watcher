/**
 * 会话钻取 /api/session/:sid 回归（F8）。
 * - 会话 ID 原样来自上游：uuid、codex 的 rollout-<时间>-<uuid>、anty-<uuid>、session_<uuid>、
 *   上游库里的不透明 ID，以及文件名 stem / dsh 目录名——后两者可含 `.`、`:` 等任意文件名字符。
 * - /api/sessions 按 (tool, session_id) 分组，钻取必须带上 tool，否则两个工具同名会话会被合并。
 * - 坏输入一律 400：空 ID、超长、控制字符、残缺的百分号编码（decodeURIComponent 会抛 → 曾是 500）。
 * 服务在临时 HOME + 离线的子进程里起（startServer 会读写数据目录），子进程逐条回报。
 * 单独运行：node test/session-drilldown.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

/** 各采集器实际产生的会话 ID 形态（见 src/collectors/*，含文件名 stem 回落） */
export const REAL_IDS = [
  '0f8e5c2a-1b3d-4e5f-8a9b-0c1d2e3f4a5b',                              // claude-code / ccmr / workbuddy / qoder / pi
  'rollout-2026-10-12T10-20-30-0f8e5c2a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', // codex 文件 stem
  'anty-0f8e5c2a-1b3d-4e5f-8a9b-0c1d2e3f4a5b',                        // antigravity
  'session_0f8e5c2a-1b3d-4e5f-8a9b-0c1d2e3f4a5b',                     // kimi 会话目录
  'ses_3a9f0c2be1ffe',                                                 // opencode
  'agent-a1b2c3d4',                                                    // claude 子代理文件 stem
  'proj.v2.session',                                                   // 文件 stem / dsh 目录名带点
  'host:1234:abc',                                                     // 上游自定 ID 带冒号
  'my session (copy)',                                                 // 文件名可含空格、括号
  '会话-1',                                                             // 非 ASCII 文件名
  'x'.repeat(256),                                                     // 上限
];

async function cases(ok) {
  const { Store } = await import('../src/store.js');
  const { startServer } = await import('../src/server.js');
  const { EventEmitter } = await import('node:events');
  const dir = mkdtempSync(join(tmpdir(), 'tw-sess-'));
  const st = new Store(join(dir, 's.db'));
  const now = Date.now();
  let n = 0;
  const ev = (tool, sid, total) => st.insertEvent({
    ts: now - 1000 * ++n, tool, session_id: sid, input_tokens: total, total_tokens: total, dedup_key: `sd${n}` });
  for (const id of REAL_IDS) ev('claude-code', id, 10);
  ev('codex', 'shared-id', 100); ev('codex', 'shared-id', 101); ev('claude-code', 'shared-id', 7);
  const scanner = new EventEmitter(); scanner.stats = {};
  const poller = { start() {}, status() { return []; } };
  let server;
  try {
    server = await startServer({ store: st, scanner, port: 0,
      balancePoller: poller, claudePoller: poller, cursorPoller: poller, zcodePoller: poller });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
      const r = await fetch(base + path);
      let body = null; try { body = await r.json(); } catch { /* 非 JSON */ }
      return { status: r.status, body };
    };

    // C1：真实 ID 形态都能打开
    for (const id of REAL_IDS) {
      const { status, body } = await get(`/api/session/${encodeURIComponent(id)}`);
      ok(`会话 ID 可钻取：${id.length > 40 ? `${id.slice(0, 24)}…(${id.length})` : id}`,
        status === 200 && body?.session_id === id && body?.events?.length === 1, `${status} ${JSON.stringify(body).slice(0, 120)}`);
    }

    // C2：同名会话按 tool 分开
    const codex = await get('/api/session/shared-id?tool=codex');
    ok('tool=codex 只返回 codex 的事件',
      codex.status === 200 && codex.body?.events?.length === 2 && codex.body.events.every(e => e.total_tokens >= 100),
      JSON.stringify(codex.body));
    const claude = await get('/api/session/shared-id?tool=claude-code');
    ok('tool=claude-code 只返回 claude-code 的事件',
      claude.status === 200 && claude.body?.events?.length === 1 && claude.body.events[0].total_tokens === 7,
      JSON.stringify(claude.body));
    const merged = await get('/api/session/shared-id');
    ok('不带 tool 时保持旧行为（全部工具）', merged.status === 200 && merged.body?.events?.length === 3,
      JSON.stringify(merged.body));

    // C3：坏输入 400，不是 500 也不是 200
    const bad = {
      '空 ID': '/api/session/',
      '超长 257': `/api/session/${'x'.repeat(257)}`,
      '控制字符 \\n': '/api/session/a%0Ab',
      '控制字符 DEL': '/api/session/a%7Fb',
      '残缺百分号编码': '/api/session/%E0%A4%A',
    };
    for (const [name, path] of Object.entries(bad)) {
      const { status, body } = await get(path);
      ok(`坏输入返回 400：${name}`, status === 400 && !body?.events, `${status} ${JSON.stringify(body)}`);
    }
  } finally {
    if (server) await new Promise(r => server.close(r));
    st.close(); rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 面板侧：把 web/app.js 里真实的 loadSessions / showSessionDetail 源码放进 vm 执行，DOM 与 fetch
 * 用最小桩替代。行元素从渲染出的 <tbody> HTML 解析（class 与 data-* 属性，含实体反转义），
 * 点击后记录详情请求 URL；详情图记录 setOption / clear，详情框记录 display。
 */
async function dashboardCases(ok) {
  const src = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const start = src.indexOf('async function loadSessions(');
  const end = src.indexOf('\ndocument.getElementById(\'sess-date\')', start);
  ok('app.js 中找到会话钻取函数', start >= 0 && end > start);
  if (start < 0 || end < 0) return;
  const { esc } = await import(pathToFileURL(join(ROOT, 'web/lib/format.js')).href);
  const { TOOL_LABEL } = await import(pathToFileURL(join(ROOT, 'web/lib/theme.js')).href);
  const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const sessions = [
    { session_id: 'shared-id', tool: 'codex', first_ts: 1, last_ts: 2, calls: 2, total: 201, peak: 101, models: '', project: null },
    { session_id: 'shared-id', tool: 'claude-code', first_ts: 1, last_ts: 2, calls: 1, total: 7, peak: 7, models: '', project: null },
    { session_id: 'proj.v2:"x"&y', tool: 'grok', first_ts: 1, last_ts: 2, calls: 1, total: 5, peak: 5, models: '', project: null },
    // Cursor 账户级计费：没有会话 ID（库里是 NULL）
    { session_id: null, tool: 'cursor', first_ts: 1, last_ts: 2, calls: 3, total: 4242, peak: 0, models: '', project: null },
    // 空串 ID 同样打不开（/api/session/ → 400），按无 ID 处理
    { session_id: '', tool: 'cursor', first_ts: 1, last_ts: 2, calls: 1, total: 4343, peak: 0, models: '', project: null },
  ];
  const noSid = (s) => s.session_id == null || s.session_id === '';
  const requests = [];
  // 详情接口的应答按会话 ID 安排；默认一条事件
  let detail = () => ({ body: { events: [{ ts: 1, total_tokens: 1 }] } });
  const els = {};
  const el = (id) => (els[id] ??= {
    id, value: '', textContent: '', style: {}, _html: '', rows: [],
    set innerHTML(h) {
      this._html = h;
      const body = h.slice(h.indexOf('<tbody>') + '<tbody>'.length);
      this.rows = h.includes('<tbody>') ? body.split('<tr').slice(1).map((chunk) => {
        const attrs = chunk.slice(0, chunk.indexOf('>'));
        const dataset = {};
        for (const [, k, v] of attrs.matchAll(/data-([a-z]+)="([^"]*)"/g)) dataset[k] = unesc(v);
        const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean);
        // 标记里写死的内联样式也要算进去（浏览器会把它解析成 style 属性）
        const style = {};
        for (const decl of unesc((attrs.match(/style="([^"]*)"/) || [, ''])[1]).split(';')) {
          const at = decl.indexOf(':');
          if (at > 0) style[decl.slice(0, at).trim().replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = decl.slice(at + 1).trim();
        }
        return { cls, dataset, html: chunk, style, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } };
      }) : [];
    },
    get innerHTML() { return this._html; },
    querySelectorAll(sel) { return sel === '.sess-row' ? this.rows.filter(r => r.cls.includes('sess-row')) : []; },
  });
  const chart = { titles: [], cleared: 0, resize() {}, setOption(o) { this.titles.push(o?.title?.text); }, clear() { this.cleared++; } };
  const context = vm.createContext({
    device: 'all', sessionsRequest: 0,
    usageUrl: (await import('../web/lib/devices.js')).usageUrl,
    document: { getElementById: el },
    fetch: async (u) => {
      requests.push(u);
      if (u.startsWith('/api/sessions')) return { ok: true, status: 200, json: async () => ({ sessions }) };
      const { status = 200, body, reject, badJson, wait, jsonWait } = detail(u);
      if (wait) await wait;
      // 错误对象取自面板所在的 realm（浏览器里 fetch / json() 抛的就是页面自己的 TypeError / SyntaxError）
      if (reject) throw vm.runInContext("new TypeError('Failed to fetch')", context);
      return { ok: status === 200, status, json: async () => {
        if (jsonWait) await jsonWait;
        if (badJson) throw vm.runInContext("new SyntaxError('bad json')", context);
        return body;
      } };
    },
    esc, encodeURIComponent, Date, JSON, Promise,
    TOOL_LABEL, prettyModel: (m) => m, fmt: String, fmtShort: String,
    charts: { sess: chart },
    cssVar: () => '', chartTooltip: (_k, o) => o, isLight: () => false,
  });
  vm.runInContext(`${src.slice(start, end)}\nglobalThis.__load = loadSessions;`, context);
  await context.__load('2026-10-12');
  const rows = el('sessions').rows;
  const click = async (row) => { row?.handlers.click?.(); await new Promise(r => setImmediate(r)); };
  ok('会话列表渲染出每一行', rows.length === sessions.length, String(rows.length));
  for (const [i, s] of sessions.entries()) {
    if (noSid(s)) continue;
    requests.length = 0;
    await click(rows[i]);
    const want = `/api/session/${encodeURIComponent(s.session_id)}?tool=${encodeURIComponent(s.tool)}&device=all`;
    ok(`点击 ${s.tool} 行只请求该 (tool, 会话)`, requests.length === 1 && requests[0] === want, `${JSON.stringify(requests)} ≠ ${want}`);
    ok(`${s.tool} 行可点击（指针）`, rows[i]?.style.cursor === 'pointer', JSON.stringify(rows[i]?.style));
  }

  // 无会话 ID 的行（NULL 与空串）：照常显示，但不可点击
  for (const [i, s] of sessions.entries()) {
    if (!noSid(s)) continue;
    const row = rows[i];
    const tag = s.session_id === null ? 'NULL' : '空串';
    ok(`无会话 ID 行：${tag} 仍然渲染（工具名与 tokens 可见）`,
      !!row && row.html.includes(TOOL_LABEL[s.tool]) && row.html.includes(String(s.total)), row?.html?.slice(0, 200));
    ok(`无会话 ID 行：${tag} 没有指针光标`, !!row && row.style.cursor !== 'pointer', JSON.stringify(row?.style));
    ok(`无会话 ID 行：${tag} 没有点击处理`, !!row && !row.handlers.click, Object.keys(row?.handlers || {}).join(','));
    requests.length = 0;
    await click(row);
    ok(`无会话 ID 行：${tag} 点击不发请求`, requests.length === 0, JSON.stringify(requests));
  }

  // 详情标题带工具名：同 ID 的 codex / claude-code 会话标题不同
  chart.titles.length = 0;
  await click(rows[0]); await click(rows[1]);
  const [tCodex, tClaude] = chart.titles;
  ok('详情标题：带 codex 的工具名', typeof tCodex === 'string' && tCodex.includes(TOOL_LABEL.codex), String(tCodex));
  ok('详情标题：带 claude-code 的工具名', typeof tClaude === 'string' && tClaude.includes(TOOL_LABEL['claude-code']), String(tClaude));
  ok('详情标题：同 ID 不同工具的标题不同', !!tCodex && tCodex !== tClaude, `${tCodex} | ${tClaude}`);
  ok('详情标题：仍含会话 ID 前缀', !!tCodex && tCodex.includes('shared-id'), String(tCodex));
  // 未登记的工具名原样回落
  chart.titles.length = 0;
  await context.showSessionDetail('abc', 'mystery-tool');
  ok('详情标题：未知工具回落为原名', String(chart.titles[0]).includes('mystery-tool'), String(chart.titles[0]));

  // 空详情 / 出错：收起并清空，不能留着上一个会话的图
  const failures = {
    '事件为空': () => ({ body: { events: [] } }),
    '400 错误体': () => ({ status: 400, body: { error: 'bad session id' } }),
    '请求失败': () => ({ reject: true }),
    '应答不是 JSON': () => ({ status: 200, badJson: true }),
  };
  for (const [name, reply] of Object.entries(failures)) {
    detail = () => ({ body: { events: [{ ts: 1, total_tokens: 1 }] } });
    await click(rows[0]);
    const shown = el('sess-detail').style.display === 'block';
    const clearedBefore = chart.cleared;
    detail = reply;
    await click(rows[1]);
    ok(`空详情：${name}时收起详情框`, shown && el('sess-detail').style.display === 'none',
      `shown=${shown} display=${el('sess-detail').style.display}`);
    ok(`空详情：${name}时清空上一张图`, chart.cleared > clearedBefore, `cleared ${clearedBefore}→${chart.cleared}`);
  }
  // 之后再点有数据的行，详情框重新出现
  detail = () => ({ body: { events: [{ ts: 1, total_tokens: 1 }] } });
  await click(rows[0]);
  ok('空详情：之后点有数据的行重新显示', el('sess-detail').style.display === 'block', el('sess-detail').style.display);

  const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
  };
  const success = () => ({ body: { events: [{ ts: 1, total_tokens: 1 }] } });
  // A 先请求，B 先显示：A 的迟到成功、空数据及各种失败均不能影响 B。
  for (const [name, reply] of Object.entries({ ...failures, '成功': success })) {
    const gate = deferred();
    let n = 0;
    detail = () => ++n === 1 ? { ...reply(), wait: gate.promise } : success();
    const old = context.showSessionDetail('older', 'codex');
    await context.showSessionDetail('newer', 'claude-code');
    const titles = chart.titles.length, cleared = chart.cleared;
    gate.resolve();
    await old;
    ok(`迟到${name}不覆盖最新详情`, el('sess-detail').style.display === 'block'
      && chart.titles.length === titles && chart.titles.at(-1).includes('newer'));
    ok(`迟到${name}不清空最新详情`, chart.cleared === cleared);
  }

  // fetch 已成功但 JSON 还未完成，也是旧请求；仅在 fetch 后检查一次不够。
  const bodyGate = deferred();
  let n = 0;
  detail = () => ++n === 1 ? { ...success(), jsonWait: bodyGate.promise } : success();
  const oldBody = context.showSessionDetail('older-body', 'codex');
  await new Promise(r => setImmediate(r));
  await context.showSessionDetail('newer-body', 'claude-code');
  const titles = chart.titles.length;
  bodyGate.resolve();
  await oldBody;
  ok('迟到 JSON 不覆盖最新详情', chart.titles.length === titles && chart.titles.at(-1).includes('newer-body'));

  // 最新请求失败时保持收起，旧成功不能重新显示；同 ID 重试同样按请求顺序判断。
  const retryGate = deferred();
  n = 0;
  detail = () => ++n === 1 ? { ...success(), wait: retryGate.promise } : { reject: true };
  const oldRetry = context.showSessionDetail('same-id', 'codex');
  await context.showSessionDetail('same-id', 'codex');
  const titlesAfterFailure = chart.titles.length;
  retryGate.resolve();
  await oldRetry;
  ok('同 ID 旧成功不能重开最新失败收起的详情', el('sess-detail').style.display === 'none'
    && chart.titles.length === titlesAfterFailure);
}

export async function testSessionDrilldown(ok) {
  await dashboardCases(ok);
  console.log('\n[会话钻取] /api/session/:sid');
  const home = mkdtempSync(join(tmpdir(), 'tw-sess-home-'));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SELF, 'child'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TOKENMETER_OFFLINE: '1', TOKENMETER_NO_KEYCHAIN: '1' } });
  rmSync(home, { recursive: true, force: true });
  const lines = r.stdout.split('\n').filter(l => /^(PASS|FAIL)\t/.test(l));
  ok('会话钻取子进程正常结束', r.status === 0 && lines.length >= REAL_IDS.length + 8, (r.stderr || '').slice(0, 400));
  for (const l of lines) { const [verdict, name, detail = ''] = l.split('\t'); ok(name, verdict === 'PASS', detail); }
}

if (process.argv[2] === 'child') {
  const ok = (name, cond, detail = '') =>
    console.log(`${cond ? 'PASS' : 'FAIL'}\t${name}\t${String(detail).replace(/[\t\n]/g, ' ')}`);
  try { await cases(ok); process.exit(0); }
  catch (err) { console.error(err); process.exit(1); }
} else if (process.argv[1] === SELF) {
  // 单独运行：自带计数与退出码
  let failed = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) console.log(`  ✓ ${name}`);
    else { failed++; console.error(`  ✗ ${name} ${detail}`); }
  };
  await testSessionDrilldown(ok);
  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
  process.exit(failed ? 1 : 0);
}
