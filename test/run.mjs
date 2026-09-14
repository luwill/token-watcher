/**
 * TokenMeter 回归测试（零依赖，node test/run.mjs 或 npm test）
 *
 * 三层：
 *  1. 语法层：所有 JS 过 node --check
 *  2. 静态断言层：render() 经 safe() 调用的函数必须有定义（拦"误删函数"回归）；
 *     app.js 引用的 DOM id / 图表容器必须存在于 index.html（拦"改布局漏容器"回归）
 *  3. 端到端冒烟：临时 HOME 下生成各源 fixtures（含 dedup/别名/累计差分/单位换算等
 *     易错点），scan 两次（幂等），断言 DB 黄金数字与 /api/summary 结构
 */
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

/* ---------- 第 1 层：语法 ---------- */
console.log('\n[1] 语法检查');
{
  const { globSync } = await import('node:fs');
  const files = [
    ...globSync(join(ROOT, 'src/**/*.js')),
    ...globSync(join(ROOT, 'bin/*.js')),
    ...globSync(join(ROOT, 'web/*.js')),
  ];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    ok(`node --check ${f.replaceAll(ROOT + '/', '')}`, r.status === 0, r.stderr.slice(0, 120));
  }
}

/* ---------- 第 2 层：静态断言 ---------- */
console.log('\n[2] 静态断言');
{
  const app = read(join(ROOT, 'web/app.js'));
  const html = read(join(ROOT, 'web/index.html'));

  // safe('name', () => fn(...)) 调用的函数必须有定义
  const calls = [...app.matchAll(/safe\('\w+',\s*\(\)\s*=>\s*(\w+)\(/g)].map(m => m[1]);
  ok('render() safe 列表非空', calls.length >= 8, `仅 ${calls.length} 个`);
  for (const fn of new Set(calls)) {
    ok(`函数存在: ${fn}()`, new RegExp(`function ${fn}\\(|const ${fn} =`).test(app));
  }

  // app.js 引用的 DOM id 必须在 index.html
  const ids = new Set([...app.matchAll(/getElementById\('([\w-]+)'\)/g)].map(m => m[1]));
  const chartIds = new Set([...app.matchAll(/\['\w+',\s*'([\w-]+)'\]/g)].map(m => m[1]));
  const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
  for (const id of [...ids, ...chartIds]) {
    ok(`HTML 有 id=${id}`, htmlIds.has(id));
  }
}

/* ---------- 第 3 层：端到端冒烟 ---------- */
console.log('\n[3] 端到端冒烟（临时 HOME + fixtures）');
const HOME = mkdtempSync(join(tmpdir(), 'tokenmeter-test-'));
const dbFile = join(HOME, '.tokenmeter', 'tokenmeter.db');
{
  // ---- fixtures（时间戳用"现在"附近，避免健康检查把过去时间的 fixture 判为 stale）----
  const NOW = Date.now();
  const ISO = (msAgo) => new Date(NOW - msAgo).toISOString();
  const w = (p, lines) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, lines.join('\n') + '\n'); };

  // Claude：两行同 id+requestId（dedup）+ 一行独立
  const aMsg = (id, ts, inTok, cached, out) => JSON.stringify({
    timestamp: ts, type: 'assistant', requestId: 'r1', sessionId: 's-claude', cwd: '/work/projA',
    message: { id, model: 'claude-opus-5', usage: { input_tokens: inTok, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: out } },
  });
  w(join(HOME, '.claude/projects/-work-projA/s-claude.jsonl'), [
    aMsg('m1', ISO(60000), 100, 500, 40),
    aMsg('m1', ISO(60000), 100, 500, 40), // 重复行 → dedup
    aMsg('m2', ISO(30000), 10, 90, 5),
  ]);

  // ccmr：deepseek-flash → 别名归一为 deepseek-v4.1-flash
  w(join(HOME, '.claude-gateway/projects/-work-projB/s-ccmr.jsonl'), [JSON.stringify({
    timestamp: ISO(50000), type: 'assistant', requestId: 'r2', sessionId: 's-ccmr',
    message: { id: 'm3', model: 'deepseek-flash', usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 200 } },
  })]);

  // Codex：session_meta + 新格式模型 + token_count 累计差分 + rate_limits
  w(join(HOME, '.codex/sessions/2026/09/14/rollout-2026-09-14T12-00-00-fixture.jsonl'), [
    JSON.stringify({ timestamp: ISO(45000), type: 'session_meta', payload: { id: 'fixture', session_id: 'parent', cwd: '/work/projC' } }),
    JSON.stringify({ timestamp: ISO(44000), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-test' } } }),
    JSON.stringify({ timestamp: ISO(43000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 120 } },
      rate_limits: { primary: { used_percent: 42, window_minutes: 10080, resets_at: 1799999999 }, plan_type: 'testplan' } } }),
    JSON.stringify({ timestamp: ISO(30000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 350, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 400 } } } }),
  ]);

  // Grok：秒级时间戳 + turn_completed（modelUsage 拆分）+ tool_call
  w(join(HOME, '.grok/sessions/%2Fwork%2FprojD/s-grok/updates.jsonl'), [
    JSON.stringify({ timestamp: Math.floor(NOW / 1000) - 500, method: 'session/update', params: { sessionId: 's-grok',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Web search', kind: 'search' } } }),
    JSON.stringify({ timestamp: Math.floor(NOW / 1000) - 400, method: 'session/update', params: { sessionId: 's-grok',
      update: { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100, cachedReadTokens: 1500, cacheCreationTokens: 0, reasoningTokens: 20,
        modelUsage: { 'grok-4.6-build': { inputTokens: 2000, outputTokens: 100, totalTokens: 2100, cachedReadTokens: 1500, cacheCreationTokens: 0, reasoningTokens: 20 } } } } } }),
  ]);

  // WorkBuddy：input 含 cache + traceId
  w(join(HOME, '.WorkBuddy/projects/-WorkBuddy-projE/s-wb.jsonl'), [JSON.stringify({
    timestamp: NOW - 30000, type: 'assistant', id: 'wb1', sessionId: 's-wb',
    providerData: { model: 'GLM-5.3-Flash', traceId: 't1' },
    message: { usage: { input_tokens: 500, output_tokens: 50, total_tokens: 550, cache_read_input_tokens: 400 } },
  })]);

  // ZCode：sqlite fixtures
  const zdir = join(HOME, '.zcode/cli/db');
  mkdirSync(zdir, { recursive: true });
  {
    const z = new DatabaseSync(join(zdir, 'db.sqlite'));
    z.exec(`CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT, model_id TEXT,
      status TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, computed_total_tokens INTEGER)`);
    z.exec(`CREATE TABLE tool_usage (session_id TEXT, tool_name TEXT, started_at INTEGER)`);
    z.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)`);
    z.prepare(`INSERT INTO model_usage VALUES ('u1','s-zc','prov','GLM-5.3','completed',?,800,60,0,0,700,860)`).run(NOW - 20000);
    z.prepare(`INSERT INTO tool_usage VALUES ('s-zc','Bash',?)`).run(NOW - 20000);
    z.prepare(`INSERT INTO session VALUES ('s-zc','/work/projF')`).run();
    z.close();
  }

  // 本地定价（离线可算费用；deepseek/glm 覆盖 fixtures 模型）
  mkdirSync(join(HOME, '.tokenmeter'), { recursive: true });
  writeFileSync(join(HOME, '.tokenmeter', 'pricing.json'), JSON.stringify({
    usd_to_cny: 7.0,
    models: {
      'deepseek-v4.1-flash': { currency: 'CNY', input_miss: 2, input_hit: 0.4, output: 8 },
      'glm-5.3-flash': { currency: 'CNY', input_miss: 1, input_hit: 0.3, output: 4 },
      'gpt-test': { currency: 'CNY', input_miss: 10, input_hit: 2, output: 30 },
    },
  }));
}

const env = { ...process.env, HOME, TOKENMETER_TEST: '1' };
const cli = (args) => spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'bin/tokenmeter.js'), ...args], { encoding: 'utf8', env });

{
  const r1 = cli(['scan']);
  ok('scan 第一次退出码 0', r1.status === 0, r1.stderr.slice(0, 200));
  const r2 = cli(['scan']);
  ok('scan 第二次退出码 0（幂等路径）', r2.status === 0, r2.stderr.slice(0, 200));

  const db = new DatabaseSync(dbFile, { readOnly: true });
  const q = (sql, ...a) => db.prepare(sql).all(...a);

  // 黄金数字（手算）：claude 640+105=745；ccmr 10200；codex 差分 400-120=280（in350/c100/out50 → fresh 250, cached 100, total 300）
  const byTool = Object.fromEntries(q('SELECT tool, SUM(total_tokens) t, COUNT(*) n FROM events GROUP BY tool').map(r => [r.tool, r]));
  ok('claude-code 2 事件（dedup 生效）', byTool['claude-code']?.n === 2, JSON.stringify(byTool['claude-code']));
  ok('claude-code 总量 745', byTool['claude-code']?.t === 745);
  ok('ccmr 10200', byTool.ccmr?.t === 10200);
  ok('codex 差分 280', byTool.codex?.t === 280, JSON.stringify(byTool.codex));
  ok('grok 2100（秒→毫秒换算）', byTool.grok?.t === 2100);
  ok('workbuddy 550', byTool.workbuddy?.t === 550);
  ok('zcode 860', byTool.zcode?.t === 860);
  const total = Object.values(byTool).reduce((s, r) => s + r.t, 0);
  ok('全源合计 14735', total === 14735, String(total));

  // 模型别名与归一
  const models = Object.fromEntries(q('SELECT model, COUNT(*) n FROM events GROUP BY model').map(r => [r.model, r.n]));
  ok("deepseek-flash → deepseek-v4.1-flash", models['deepseek-v4.1-flash'] === 1 && !models['deepseek-flash']);
  ok('GLM-5.3-Flash → glm-5.3-flash（小写归一）', models['glm-5.3-flash'] === 1);

  // 幂等：二次扫描不重复
  const n2 = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  ok('事件总数 7（幂等）', n2 === 7, String(n2));

  // tool_calls
  const tc = Object.fromEntries(q('SELECT tool, COUNT(*) n FROM tool_calls GROUP BY tool').map(r => [r.tool, r.n]));
  ok('grok 工具调用 1', tc.grok === 1);
  ok('zcode 工具调用 1', tc.zcode === 1);

  // Codex 配额快照
  const quota = JSON.parse(db.prepare(`SELECT data FROM quota WHERE tool='codex'`).get()?.data ?? 'null');
  ok('codex 配额 42%', quota?.used_percent === 42 && quota?.plan_type === 'testplan');

  // project 捕获
  const proj = Object.fromEntries(q('SELECT tool, project FROM events GROUP BY tool').map(r => [r.tool, r.project]));
  ok('codex project=projC（session_meta 顶层 type）', proj.codex === 'projC');
  ok('grok project=projD（URL 解码）', proj.grok === 'projD');
  ok('zcode project=projF（session.directory）', proj.zcode === 'projF');
  db.close();
}

/* ---------- API 冒烟 ---------- */
console.log('\n[4] API 冒烟');
{
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ['--no-warnings', join(ROOT, 'bin/tokenmeter.js'), 'serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', d => { buf += d; });
  const started = await new Promise(r => { const t = setTimeout(() => r(false), 30000); child.stdout.on('data', () => { if (buf.includes('listening')) { clearTimeout(t); r(true); } }); });
  ok('serve 启动', started);

  if (started) {
    const res = await fetch(`http://127.0.0.1:${port}/api/summary?days=7`);
    const s = await res.json();
    ok('summary 200 且结构完整',
      res.status === 200 && s.totals?.all_time_tokens === 14735 && Array.isArray(s.by_day) && s.by_day.length >= 1
      && Array.isArray(s.health) && s.health.length === 7 && s.costs && Array.isArray(s.costs.by_day)
      && Array.isArray(s.recent) && s.recent.length === 7,
      `totals=${s.totals?.all_time_tokens} health=${s.health?.length}`);
    const okTools = s.health.filter(h => h.status === 'ok').length;
    ok('健康 7 源全 ok（dsh 无 fixture 应为 empty 而非 error）', okTools === 6, `${okTools} ok（dsh=empty）`);
    ok('费用 by_day 有值（本地定价离线可算）', s.costs.by_day.length >= 1 && s.costs.today_cny >= 0);
  }
  child.kill('SIGTERM');
}

/* ---------- 清理 ---------- */
rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);

function read(p) { return readFileSync(p, 'utf8'); }
import { readFileSync } from 'node:fs';
