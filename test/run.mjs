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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import http from 'node:http';

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
    ...globSync(join(ROOT, 'web/lib/*.js')),
  ];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    ok(`node --check ${f.replaceAll(ROOT + '/', '')}`, r.status === 0, r.stderr.slice(0, 120));
  }
}

/* ---------- 第 1b 层：import 冒烟 ----------
 * node --check 只解析语法，不解析模块图：缺失的导出、给只读导出赋值这类错误它一概看不见。
 * 真实事故就是这么来的——server.err.log 里 12 次启动崩溃全是
 * "does not provide an export named 'setOnChange'" 与 "Cannot assign to read only property"。 */
console.log('\n[1b] import 冒烟（模块级错误）');
{
  const { globSync } = await import('node:fs');
  const mods = [...globSync(join(ROOT, 'src/**/*.js')), ...globSync(join(ROOT, 'web/lib/*.js'))];
  ok('待冒烟模块非空', mods.length >= 15, `仅 ${mods.length} 个`);
  for (const f of mods) {
    const rel = f.replaceAll(ROOT + '/', '');
    try {
      await import(pathToFileURL(f).href);
      ok(`import ${rel}`, true);
    } catch (err) {
      ok(`import ${rel}`, false, err.message.slice(0, 140));
    }
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

  // 悬浮框不得被图表容器裁切：.pair .panel .chart 带 overflow:hidden（挡 flex 反馈循环），
  // 而 ECharts 默认把 tooltip 挂进该容器 → 必须统一改为挂 body + 夹在视口内
  const css = read(join(ROOT, 'web/style.css'));
  ok('成对行图表容器仍 overflow:hidden', /\.pair \.panel \.chart \{[^}]*overflow:\s*hidden/.test(css));
  const tips = [...app.matchAll(/tooltip:\s*(.+)/g)].map(m => m[1].trim());
  ok('图表 tooltip 数量符合预期', tips.length === 6, `实际 ${tips.length} 个`);
  for (const t of tips) {
    ok(`tooltip 走统一配置: ${t.slice(0, 34)}`, /^\w*[Tt]ooltip\w*\(/.test(t));
  }
  // 悬浮框的挂载点与视口夹取现在由 [2b] 直接 import lib/tooltip.js 做行为断言，此处只守"都走统一配置"

  // symbol:'none' 的折线没有可命中的图元，item 触发（默认）的悬浮框永远弹不出来，
  // 必须配 trigger:'axis'。会话钻取曲线曾长期踩这个坑。
  const sessFn = app.match(/async function showSessionDetail\([\s\S]*?\n\}/)?.[0] || '';
  ok('会话钻取曲线仍是无图元折线', /symbol:\s*'none'/.test(sessFn));
  ok('无图元折线用 axis 触发悬浮框（否则永远不弹）', /trigger:\s*'axis'/.test(sessFn));

  // 后端 500 时旧 load() 会在 render() 里抛 TypeError，页面静默停在旧数据上
  const loadFn = app.match(/async function load\([\s\S]*?\n\}/)?.[0] || '';
  ok('load() 处理请求失败', /catch|res\.ok/.test(loadFn), loadFn.slice(0, 60));
  ok('加载失败有可见提示而非静默停更', /load-error/.test(app));

  // node:sqlite 在 22.13.0 之前需要 --experimental-sqlite，engines 低于此值 npx 用户会直接报错
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  const mv = (pkg.engines?.node || '').match(/(\d+)\.(\d+)/);
  ok('engines.node 不低于 node:sqlite 免 flag 的 22.13',
    !!mv && (Number(mv[1]) > 22 || (Number(mv[1]) === 22 && Number(mv[2]) >= 13)), pkg.engines?.node);
  // --no-warnings 会连带吞掉未来的弃用提示，只该屏蔽实验特性警告
  const scripts = Object.values(pkg.scripts || {}).join(' ');
  ok('不再用 --no-warnings 屏蔽全部警告', !/--no-warnings(\s|$)/.test(scripts), scripts);
}

/* ---------- 第 2b 层：前端纯函数（真实 import，不再正则抽源码） ---------- */
console.log('\n[2b] 前端纯函数（lib/）');
{
  const app = read(join(ROOT, 'web/app.js'));
  const lib = (f) => import(pathToFileURL(join(ROOT, 'web/lib', f)).href);
  const { pickSeries, assignSlots, stackTipFormatter, dayAxis, fillDays } = await lib('series.js');
  const { esc, fmt, fmtShort, ymd } = await lib('format.js');
  const { MODEL_PALETTE, TOOL_COLORS } = await lib('theme.js');
  const { chartTooltip, tooltipPosition } = await lib('tooltip.js');

  // ---- 转义：面板整页靠 innerHTML 拼接，插值来自本地目录名与各工具 transcript ----
  ok('esc 转义尖括号',
    esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', esc('<img src=x>'));
  ok('esc 转义属性上下文的引号', esc('a"b\'c') === 'a&quot;b&#39;c', esc('a"b\'c'));
  ok('esc 先转义 & 不产生双重转义', esc('a&lt;b') === 'a&amp;lt;b', esc('a&lt;b'));
  ok('esc 把 null/undefined 变空串', esc(null) === '' && esc(undefined) === '');

  // ---- 本地日期：用 UTC 的 toISOString 会让东八区凌晨算成前一天，与后端分桶对不上 ----
  ok('ymd 用本地时区各字段', ymd(new Date(2026, 8, 15, 0, 30)) === '2026-09-15', ymd(new Date(2026, 8, 15, 0, 30)));
  ok('ymd 补零', ymd(new Date(2026, 0, 5)) === '2026-01-05', ymd(new Date(2026, 0, 5)));

  // ---- 数值格式化（独立手算对照）----
  ok('fmt 万分档', fmt(12345) === '1.2 万', fmt(12345));
  ok('fmt 亿分档', fmt(123456789) === '1.23 亿', fmt(123456789));
  ok('fmtShort K/M 分档', fmtShort(1500) === '2K' && fmtShort(1500000) === '1.5M',
    `${fmtShort(1500)} ${fmtShort(1500000)}`);

  // ---- 日期轴：两个按天图共用一条轴，否则同一天落在不同的 x 上 ----
  const sparse = [{ day: '2026-09-13' }, { day: '2026-09-15' }];
  ok('dayAxis 补齐日期空洞',
    dayAxis(sparse, 90).join(',') === '2026-09-13,2026-09-14,2026-09-15', dayAxis(sparse, 90).join(','));
  ok('dayAxis 结果可复现（两图共用同一轴）',
    dayAxis(sparse, 90).join(',') === dayAxis([...sparse], 90).join(','));
  ok('dayAxis 空输入不炸', dayAxis([], 90).length === 0);
  ok('dayAxis 超长跨度不补洞',
    dayAxis([{ day: '2020-01-01' }, { day: '2026-09-15' }], 90).length === 2);
  ok('fillDays 给补出来的日子填空壳',
    fillDays(sparse, 90)[1].day === '2026-09-14' && fillDays(sparse, 90)[1].total === 0);
  // 单一事实源：消耗图走 fillDays、花费图走 dayAxis，两者必须逐日一致，否则同一天落在不同的 x 上
  ok('fillDays 与 dayAxis 产出同一条轴',
    fillDays(sparse, 90).map(r => r.day).join(',') === dayAxis(sparse, 90).join(','));

  // ---- 悬浮框只列当日真正用到的系列：0 的那些不属于"今天用了什么" ----
  const bags = [{ zcode: 100, grok: 0 }];
  const tip = stackTipFormatter(String, i => bags[i], [], '');
  const out = tip([
    { axisValue: '09-15', seriesName: 'ZCode', value: 100, marker: '*', dataIndex: 0 },
    { axisValue: '09-15', seriesName: 'Grok', value: 0, marker: '*', dataIndex: 0 },
  ]);
  ok('悬浮框不列 0 用量的系列', !out.includes('Grok') && out.includes('ZCode'), out);
  ok('悬浮框带合计', out.includes('合计'), out);
  ok('悬浮框转义系列名', stackTipFormatter(String, () => ({}), [], '')(
    [{ axisValue: 'x', seriesName: '<b>hack</b>', value: 1, marker: '*', dataIndex: 0 }]).includes('&lt;b&gt;'));

  // 「其他」段展开成员，长尾不被藏起来
  const bags2 = [{ a: 5, b: 3, c: 0 }];
  const tip2 = stackTipFormatter(String, i => bags2[i], ['b', 'c'], '其他(2)');
  const out2 = tip2([{ axisValue: '09-15', seriesName: '其他(2)', value: 8, marker: '*', dataIndex: 0 }]);
  ok('「其他」在悬浮框里展开成员', out2.includes('b 3') && !out2.includes('c 0'), out2);

  // ---- 系列选择 ----
  const rows = [
    { day: '2026-09-13', bag: { a: 10, b: 5 } },
    { day: '2026-09-14', bag: { a: 3, b: 7 } },
    { day: '2026-09-15', bag: { c: 1 } },   // c 今天首用；a、b 今天为 0
  ];
  const r1 = pickSeries(rows, r => r.bag, 8);
  // a 今天没量但 09-14 有量 → 必须保留，否则 09-14 的柱子没有图例可解释
  ok('当日为 0 但范围内用过的键仍保留', ['a', 'b', 'c'].every(k => r1.keys.includes(k)), JSON.stringify(r1));
  // c 最近使用(09-15)排最前；a、b 同为 09-14，按范围内用量降序 → a(13) 在 b(12) 前
  ok('最近使用的排最前，同日按用量降序', r1.keys.join(',') === 'c,a,b', JSON.stringify(r1.keys));
  ok('从未用过的键不返回', !r1.keys.includes('zzz') && !r1.rest.includes('zzz'));

  // 回归：曾经按花费排名 slice(0,7) 硬截断，导致新用的小额模型整条消失
  const many = [{ day: '2026-09-15', bag: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`m${i}`, i + 1])) }];
  const r2 = pickSeries(many, r => r.bag, 8);
  ok('超出色板容量时归入「其他」而非丢弃',
    r2.keys.length === 8 && r2.rest.length === 10, `keys=${r2.keys.length} rest=${r2.rest.length}`);
  ok('keys+rest 覆盖全部用过的键（一个都不丢）', new Set([...r2.keys, ...r2.rest]).size === 18);

  // ---- 配色：Color follows the entity, never its rank ----
  const st = new Map();
  const before = assignSlots(['alpha', 'beta', 'gamma'], 8, st);
  const after = assignSlots(['alpha', 'beta', 'gamma', 'minimax-m3'], 8, st);
  ok('新增模型不改变已有模型配色',
    ['alpha', 'beta', 'gamma'].every(m => before.get(m) === after.get(m)));
  ok('单次渲染内不撞色', new Set(after.values()).size === 4);
  const reordered = assignSlots(['gamma', 'beta', 'alpha'], 8, st);
  ok('顺序/排名变化不改变配色',
    ['alpha', 'beta', 'gamma'].every(m => reordered.get(m) === before.get(m)));

  // 色板本身必须是校验过的 8 槽（改色需重跑 validate_palette.js）
  ok('MODEL_PALETTE 为 8 槽', MODEL_PALETTE.length === 8, String(MODEL_PALETTE.length));
  ok('MODEL_PALETTE 使用校验过的色板', MODEL_PALETTE.join(',') ===
    '#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767', MODEL_PALETTE.join(','));
  ok('每个数据源都有品牌色', Object.keys(TOOL_COLORS).length === 7, String(Object.keys(TOOL_COLORS).length));

  // ---- 悬浮框定位：只 appendToBody 不够，图表贴顶时会被浏览器窗口继续裁 ----
  ok('悬浮框挂到 body（脱离 overflow:hidden 的图表容器）',
    chartTooltip({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }).appendToBody === true);
  const dom = { getBoundingClientRect: () => ({ left: 100, top: 50 }) };
  const pos = tooltipPosition(dom, { innerWidth: 400, innerHeight: 300 });
  // 光标贴近右下角、悬浮框 200×150 放不下 → 必须翻转并夹进视口
  const [lx, ly] = pos([280, 230], null, null, null, { contentSize: [200, 150] });
  const vx = lx + 100, vy = ly + 50; // 图表局部坐标 → 视口坐标
  ok('悬浮框不越出视口右/下边界', vx + 200 <= 392 && vy + 150 <= 292, `${vx},${vy}`);
  ok('悬浮框不越出视口左/上边界', vx >= 8 && vy >= 8, `${vx},${vy}`);

  // 图表系列必须来自 pickSeries，不得再按花费排名硬截断
  const costFn = app.match(/function renderCostDay\([\s\S]*?\n\}/)?.[0] || '';
  const trendFn = app.match(/function renderTrend\([\s\S]*?\n\}/)?.[0] || '';
  ok('按天花费走 pickSeries 选系列', /pickSeries\(/.test(costFn));
  ok('按天消耗走 pickSeries 选系列', /pickSeries\(/.test(trendFn));
  ok('不再按花费排名截断', !/ranked\.slice\(/.test(costFn) && !/slice\(0,\s*7\)/.test(costFn));
  ok('不再硬编码 DeepSeek 保底', !/deepseek-v4\.1-flash'\s*\?\s*'#/.test(app));
  ok('「其他」在悬浮框里展开成员', /其他/.test(costFn));

  // 柱宽一致：两张按天图必须共用同一个柱宽上限、同一套绘图区边距、同一条日期轴。
  // 三者缺一，柱子的实际渲染宽度就会不同（类目数或绘图区宽不一致时 barMaxWidth 相同也没用）
  const barMax = app.match(/const BAR_MAX_W = (\d+)/);
  ok('柱宽上限为常量', !!barMax);
  ok('柱宽上限不超过 24px（dataviz 规范）', Number(barMax?.[1]) <= 24, `实际 ${barMax?.[1]}`);
  ok('两张按天图共用柱宽上限',
    (trendFn.match(/barMaxWidth: BAR_MAX_W/g) || []).length === 1
    && (costFn.match(/barMaxWidth: BAR_MAX_W/g) || []).length === 1);
  ok('两张按天图共用绘图区边距', /\.\.\.DAY_GRID/.test(trendFn) && /\.\.\.DAY_GRID/.test(costFn));
  // 单一事实源：消耗图走 fillDays、花费图直接用 dayAxis，两者必须产出同一条轴
  ok('两张按天图共用日期轴', /fillDays\(/.test(trendFn) && /dayAxis\(/.test(costFn));
  ok('不再各自硬编码绘图区边距',
    !/grid: \{ left: 50, right: 12/.test(costFn) && !/grid: \{ left: 70, right: 16/.test(trendFn));
}

/* ---------- 第 2c 层：后端健壮性（Store / 路由错误处理） ---------- */
console.log('\n[2c] 后端健壮性');
{
  const mod = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

  // 并发读写：serve 常驻时跑 `tokenmeter today` 会撞锁，没有 busy_timeout 就是立刻 SQLITE_BUSY
  const { Store } = await mod('src/store.js');
  const tmp = mkdtempSync(join(tmpdir(), 'tokenmeter-store-'));
  const st = new Store(join(tmp, 'x.db'));
  const bt = Object.values(st.db.prepare('PRAGMA busy_timeout').get())[0];
  ok('Store 设置了 busy_timeout（并发读写不立刻 SQLITE_BUSY）', Number(bt) >= 1000, String(bt));
  st.close();
  rmSync(tmp, { recursive: true, force: true });

  // 路由异常必须变成 500：冒泡出去就是未处理 rejection，会直接杀掉常驻进程
  const { withErrors } = await mod('src/server.js');
  let code = 0, body = '';
  const res = {
    headersSent: false,
    writeHead(c) { code = c; this.headersSent = true; },
    end(b) { body = b || ''; },
  };
  await withErrors(() => { throw new Error('boom-secret-path'); })({ url: '/api/x' }, res);
  ok('路由异常转成 500 而非未处理 rejection', code === 500, String(code));
  ok('500 响应体为 JSON 且不外泄内部错误', /error/.test(body) && !body.includes('boom-secret-path'), body);

  // 对账：DeepSeek 按美元计价，旧实现要求 currency==='CNY' → 统计花费恒为 0，面板据此误报 ⚠
  const { computeRecon } = await mod('src/pricing.js');
  const rtmp = mkdtempSync(join(tmpdir(), 'tokenmeter-recon-'));
  const rdb = new DatabaseSync(join(rtmp, 'r.db'));
  rdb.exec(`CREATE TABLE events (ts INTEGER, tool TEXT, model TEXT, input_tokens INTEGER,
    cached_input INTEGER, cache_write INTEGER, output_tokens INTEGER, total_tokens INTEGER);
    CREATE TABLE balance_history (ts INTEGER, provider TEXT, balance REAL);`);
  const t = Date.now();
  rdb.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)')
    .run(t - 3_600_000, 'ccmr', 'deepseek-v4.1-flash', 1_000_000, 2_000_000, 0, 100_000, 3_100_000);
  rdb.prepare('INSERT INTO balance_history VALUES (?,?,?)').run(t - 7_200_000, 'deepseek', 130);
  rdb.prepare('INSERT INTO balance_history VALUES (?,?,?)').run(t - 60_000, 'deepseek', 127);
  const fakeStore = { getBalances: () => [{ id: 'deepseek', provider: 'DeepSeek', balance: 127 }] };
  const usdPricing = { models: { 'deepseek-v4.1-flash': { currency: 'USD', input_miss: 0.30, input_hit: 0.006, output: 1.20 } } };
  // 余额轮询熔断：GLM 端点持续 404，真实日志两天里带着 key 重试了 85 次
  const { BalancePoller } = await mod('src/balance.js');
  const etmp = mkdtempSync(join(tmpdir(), 'tokenmeter-env-'));
  writeFileSync(join(etmp, '.env'), 'DEEPSEEK_API_KEY=test-key-not-real\n');
  let calls = 0;
  const always404 = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; };
  const poller = new BalancePoller({ saveQuota() {} }, {
    fetchImpl: always404, maxClientErrors: 2, envPath: join(etmp, '.env'), log: () => {},
  });
  await poller.poll();
  await poller.poll();
  await poller.poll();
  ok('连续 4xx 后熔断，不再每轮重试', calls === 2, `实际请求 ${calls} 次`);
  ok('熔断状态可见（面板能标出来）', poller.status().some(s => s.id === 'deepseek'),
    JSON.stringify(poller.status()));
  rmSync(etmp, { recursive: true, force: true });

  const ds = computeRecon(rdb, fakeStore, usdPricing, { rate: 7.0 }).find(r => r.id === 'deepseek');
  // 手算（汇率 7.0）：1.0×0.30×7 + 2.0×0.006×7 + 0.1×1.20×7 = 2.10 + 0.084 + 0.84 = 3.024
  ok('美元计价厂商的对账花费不再恒为 0', Math.abs((ds?.spend ?? -1) - 3.024) < 1e-6, String(ds?.spend));
  ok('对账仍如实报告余额变化', Math.abs((ds?.delta ?? 0) - (-3)) < 1e-9, String(ds?.delta));
  rdb.close();
  rmSync(rtmp, { recursive: true, force: true });
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

// 离线：回归测试不该依赖公网（汇率/LiteLLM 牌价），否则断网就跑不了、时长也不可控
const env = { ...process.env, HOME, TOKENMETER_OFFLINE: '1' };
const cli = (args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenmeter.js'), ...args], { encoding: 'utf8', env });

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

/* ---------- 第 3b 层：源文件被删除（Claude 会话清理 / Codex 归档是常态） ---------- */
{
  const gone = join(HOME, '.claude/projects/-work-projA/s-claude.jsonl');
  rmSync(gone);
  const r = cli(['scan']);
  ok('源文件删除后 scan 退出码 0（不因 ENOENT 崩溃）', r.status === 0, r.stderr.slice(0, 300));

  const db = new DatabaseSync(dbFile, { readOnly: true });
  ok('已删除文件的游标行被清理（不再无限堆积）',
    db.prepare('SELECT COUNT(*) n FROM files WHERE path = ?').get(gone).n === 0);
  ok('已删除文件的历史事件仍保留（只清游标不清数据）',
    db.prepare("SELECT COUNT(*) n FROM events WHERE tool = 'claude-code'").get().n === 2);
  ok('其余源的游标行不受影响',
    db.prepare("SELECT COUNT(*) n FROM files WHERE tool = 'ccmr'").get().n === 1);
  db.close();
}

/* ---------- API 冒烟 ---------- */
console.log('\n[4] API 冒烟');
{
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenmeter.js'), 'serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

    // 离线模式：不发任何外网请求，用本地缓存/手动汇率/种子价继续出数
    ok('summary 标明处于离线模式', s.offline === true, String(s.offline));
    ok('离线时汇率不来自远端主机',
      ['default', 'cache', 'manual'].includes(s.costs.fx_source), String(s.costs.fx_source));
    ok('离线时费用仍可算（走本地 pricing.json）', s.costs.all_cny > 0, String(s.costs.all_cny));

    // DNS rebinding：只绑 127.0.0.1 挡不住恶意页面把自家域名解析到本机再读面板数据
    const rawGet = (path, headers) => new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port, path, headers }, (r) => {
        let b = ''; r.on('data', d => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      rq.on('error', () => resolve({ status: 0, body: '' }));
      rq.end();
    });
    const evil = await rawGet('/api/summary?days=1', { host: 'evil.example.com' });
    ok('伪造 Host 被拒（防 DNS rebinding）', evil.status === 403, String(evil.status));
    ok('被拒响应不携带任何用量数据', !evil.body.includes('all_time_tokens'), evil.body.slice(0, 80));
    const local = await rawGet('/api/summary?days=1', { host: `127.0.0.1:${port}` });
    ok('本机 Host 正常放行', local.status === 200, String(local.status));
    const named = await rawGet('/api/summary?days=1', { host: `localhost:${port}` });
    ok('localhost 也放行（浏览器常用）', named.status === 200, String(named.status));
  }
  child.kill('SIGTERM');
}

/* ---------- 清理 ---------- */
rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);

function read(p) { return readFileSync(p, 'utf8'); }
import { readFileSync } from 'node:fs';
