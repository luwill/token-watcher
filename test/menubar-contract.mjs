/**
 * 菜单栏 Swift 解码结构与 /api/summary 的契约（CI 无 swiftc：逐字段比对类型，
 * Decodable 遇到类型不符会整体抛错，胶囊就只剩 T--）。summary 在临时 HOME 子进程里构建。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

export async function testMenubar(ok) {
  console.log('\n[菜单栏] Codex 配额窗口解码契约');
  const sumHome = mkdtempSync(join(tmpdir(), 'tw-sum-'));
  const sr = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SELF, 'summary'], {
    encoding: 'utf8', env: { ...process.env, HOME: sumHome, USERPROFILE: sumHome, TOKENMETER_OFFLINE: '1', TOKENMETER_NO_KEYCHAIN: '1' } });
  rmSync(sumHome, { recursive: true, force: true });
  let summary = null;
  try { summary = JSON.parse(sr.stdout); } catch { /* 下面断言会报 */ }
  ok('临时 HOME 下构建出真实 summary', sr.status === 0 && summary, (sr.stderr || '').slice(0, 300));
  const swift = readFileSync(new URL('../menubar/main.swift', import.meta.url), 'utf8');
  await testMenubarContract(ok, swift, summary);
  // 有 Swift 时真实解码：合法项夹着坏项，仍保留合法项与 totals。
  if (spawnSync('swiftc', ['--version']).status === 0) {
    const dir = mkdtempSync(join(tmpdir(), 'tw-alert-swift-'));
    try {
      const model = swift.slice(swift.indexOf('struct Summary:'), swift.indexOf('func fmtTokens'));
      const item = summary.alerts.items[0];
      const payloads = [
        { totals: { today_tokens: 7 } },
        { totals: { today_tokens: 7 }, alerts: 'bad' },
        { totals: { today_tokens: 7 }, alerts: { items: [null, 1, {}, { ...item, level: 'bad' }, { ...item, value: 'bad' }, item] } },
      ];
      const encoded = JSON.stringify(payloads).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      writeFileSync(join(dir, 'main.swift'), `import Foundation\n${model}\nlet data = "${encoded}".data(using: .utf8)!\nlet rows = try JSONDecoder().decode([Summary].self, from: data)\nprecondition(rows.allSatisfy { $0.totals?.today_tokens == 7 })\nprecondition(rows[0].alerts == nil && rows[1].alerts == nil)\nprecondition(rows[2].alerts?.items.count == 1)\nprint("decode ok")\n`);
      const build = spawnSync('swiftc', [join(dir, 'main.swift'), '-o', join(dir, 'decode')], { encoding: 'utf8' });
      const run = build.status === 0 ? spawnSync(join(dir, 'decode'), [], { encoding: 'utf8' }) : build;
      ok('Swift 真实解码容忍缺失 alerts、坏容器与单项异常', run.status === 0 && run.stdout.includes('decode ok'), run.stderr.slice(0, 400));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

}

async function summaryChild() {
  const { Store } = await import('../src/store.js');
  const { buildSummary } = await import('../src/server.js');
  const { quotaFromRateLimits } = await import('../src/codexQuota.js');
  const st = new Store(join(process.env.HOME, 's.db'));
  const now = Date.now();
  st.insertEvent({ ts: now - 1000, tool: 'codex', model: 'gpt-5', total_tokens: 100, dedup_key: 's1' });
  st.insertEvent({ ts: now - 2000, tool: 'claude-code', model: 'claude-opus-5-5', session_id: 'c1', total_tokens: 50, dedup_key: 's2' });
  st.saveQuota('codex', now - 1000, quotaFromRateLimits({ limit_id: 'codex', plan_type: 'plus',
    primary: { used_percent: 85, window_minutes: 300, resets_at: 1799990000 },
    secondary: { used_percent: 42.5, window_minutes: 10080, resets_at: 1799999999 } }));
  st.saveQuota('balance:deepseek', now - 500, { provider: 'DeepSeek', balance: 12.34, currency: 'CNY' });
  const s = await buildSummary(st, {}, 1, { now });
  process.stdout.write(JSON.stringify(s));
  st.close();
}

if (process.argv[2] === 'summary') {
  try { await summaryChild(); process.exit(0); }
  catch (err) { console.error(err); process.exit(1); }
}

/**
 * 菜单栏 Swift 解码结构与 /api/summary 的 Codex 配额形状对齐（本机无 swiftc，做契约比对）。
 * Swift 的 Decodable 对可选字段"缺失"容忍、对"类型不符"整体抛错——后者会让胶囊整个显示 T--，
 * 所以逐字段比对类型，而不只看字段名。
 */
export async function testMenubarContract(ok, swiftSource, summary = null) {
  const { codexQuotaView, quotaFromRateLimits } = await import('../src/codexQuota.js');
  const structFields = (name) => {
    // 只取该结构体自身（花括号深度 1）的存储属性：嵌套结构体与计算属性的 { … } 整段跳过
    const head = swiftSource.match(new RegExp(`struct ${name}: Decodable \\{`));
    if (!head) return null;
    let depth = 1, i = head.index + head[0].length, own = '';
    for (; i < swiftSource.length && depth > 0; i++) {
      const c = swiftSource[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 1) own += c;
    }
    // 非可选字段记成 "T!"：载荷里缺失或为 null 时 Swift 会整体解码失败
    return Object.fromEntries([...own.matchAll(/var (\w+): ([\[\]\w]+)(\?)?(?=\s*(?:;|\n|$))/g)]
      .map(x => [x[1], x[3] ? x[2] : `${x[2]}!`]));
  };
  const jsType = (v) => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  const compatible = (swift, v) => swift.endsWith('!') ? v != null && compatible(swift.slice(0, -1), v) : v == null
    || (swift === 'Double' && typeof v === 'number') || (swift === 'Int' && Number.isInteger(v))
    || (swift === 'String' && typeof v === 'string') || (swift.startsWith('[') && Array.isArray(v))
    || (swift === 'Bool' && typeof v === 'boolean')
    || (!['Double', 'Int', 'String', 'Bool'].includes(swift) && !swift.startsWith('[')
      && typeof v === 'object' && !Array.isArray(v)); // 嵌套结构体：其字段另行逐个比对
  const views = {
    'plus（5h + 周）': codexQuotaView({ ts: 1, data: quotaFromRateLimits({ limit_id: 'codex', plan_type: 'plus',
      primary: { used_percent: 25, window_minutes: 300, resets_at: 1799990000 },
      secondary: { used_percent: 42, window_minutes: 10080, resets_at: 1799999999 } }) }),
    'pro（仅周）': codexQuotaView({ ts: 1, data: quotaFromRateLimits({ plan_type: 'pro',
      primary: { used_percent: 7, window_minutes: 10080, resets_at: 1799999000 } }) }),
    '旧库平铺形态': codexQuotaView({ ts: 1, data: { used_percent: 60, window_minutes: 300, plan_type: 'plus' } }),
  };
  const dataQ = structFields('DataQ'), win = structFields('Window');
  ok('菜单栏 DataQ 声明 windows 数组', dataQ?.windows === '[Window]', JSON.stringify(dataQ));
  ok('菜单栏 Window 声明 used_percent / window_minutes',
    win?.used_percent === 'Double' && win?.window_minutes === 'Double', JSON.stringify(win));
  for (const [label, view] of Object.entries(views)) {
    const bad = [];
    for (const [k, t] of Object.entries(dataQ || {})) if (!compatible(t, view.data[k])) bad.push(`data.${k}:${t}≠${jsType(view.data[k])}`);
    for (const w of view.data.windows) for (const [k, t] of Object.entries(win || {})) if (!compatible(t, w[k])) bad.push(`window.${k}:${t}≠${jsType(w[k])}`);
    ok(`菜单栏解码字段类型与后端一致：${label}`, dataQ && win && !bad.length, bad.join(' '));
    ok(`后端窗口带百分比（菜单栏取最大者）：${label}`, view.data.windows.length > 0
      && view.data.windows.every(w => typeof w.used_percent === 'number'), JSON.stringify(view.data));
  }
  // 胶囊必须看最紧的窗口，且真的从 windows 取值；标签按分钟数映射
  const usedBody = swiftSource.slice(swiftSource.indexOf('var usedPercent'), swiftSource.indexOf('var windowLines'));
  ok('菜单栏 usedPercent 从 windows 取各窗口最大值',
    /\(data\?\.windows \?\? \[\]\)\.compactMap \{ \$0\.used_percent \}/.test(usedBody)
    && /pcts\.max\(\) \?\? data\?\.used_percent/.test(usedBody), usedBody.slice(0, 200));
  ok('菜单栏窗口标签：300 分钟=5h，10080 分钟=周',
    /m == 300 \? "5h" : m == 10080 \? "周"/.test(swiftSource));
  ok('菜单栏使用服务端告警并保留级别上升与消失重置',
    swiftSource.includes('s.alerts?.items') && swiftSource.includes('if c.level > prev')
    && swiftSource.includes('!active.contains(k)') && !/pct >= (80|95)|balance! < (2|10)/.test(swiftSource));
  if (summary) {
    // 真实 buildSummary 输出：Swift 声明的每个结构体逐字段比对（任何一处类型不符都会让整次解码失败）
    const paths = { Summary: [summary], Totals: [summary.totals], Quota: [summary.quota],
      CodexQ: [summary.quota.codex], DataQ: [summary.quota.codex?.data],
      Window: summary.quota.codex?.data?.windows || [], ClaudeQ: [summary.quota.claude5h],
      Balance: summary.balances || [], AlertItem: summary.alerts.items };
    const bad = [];
    for (const [name, objs] of Object.entries(paths)) {
      const fields = structFields(name);
      if (!fields || !Object.keys(fields).length) { bad.push(`struct ${name} 未解析出字段`); continue; }
      if (objs.every(o => o == null)) bad.push(`${name} 在载荷里为空，比对空转`);
      for (const o of objs) for (const [k, t] of Object.entries(fields)) {
        if (o == null) continue;
        if (!compatible(t, o[k])) bad.push(`${name}.${k}:${t}≠${jsType(o[k])}`);
      }
    }
    ok('菜单栏全部结构体与真实 /api/summary 载荷类型一致', !bad.length, bad.join(' '));
    ok('真实载荷含 Codex 窗口与余额（比对不是空转）',
      (summary.quota.codex?.data?.windows || []).length === 2 && (summary.balances || []).length >= 1,
      JSON.stringify({ codex: summary.quota.codex, balances: summary.balances }));
  }
  ok('菜单栏胶囊 / 菜单读窗口', !/codex\?\.data\?\.used_percent/.test(swiftSource)
    && (swiftSource.match(/usedPercent/g) || []).length >= 2, '');
}
