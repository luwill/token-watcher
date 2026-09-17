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
import { mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import http from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = (await import('node:module')).createRequire(import.meta.url);
// 数据源注册表是多层断言的共同基准（前端登记、健康表长度），顶层导入一次
const { SOURCES } = await import(pathToFileURL(join(ROOT, 'src/config.js')).href);
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
  // 与注册表交叉核对，而不是数个数：新增了源却忘了登记配色/标签，
  // 面板上就是一条无色无名的堆叠段——这种漏登记正是"加源"最容易漏的一步。
  const { TOOL_LABEL } = await lib('theme.js');
  const unstyled = SOURCES.filter(s => !TOOL_COLORS[s.tool] || !TOOL_LABEL[s.tool]).map(s => s.tool);
  ok('每个注册数据源都有品牌色与标签', unstyled.length === 0, `缺登记: ${unstyled.join(',')}`);

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
let hasDsh = false; // 系统无 zstd 时 dsh 源整体跳过，相关断言随之放行
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
  // 第二条（m4）复刻网关的真实写法：不写 requestId，一次 API 响应按 content block
  // 拆成多行，input/cached 每行重复，只有终结块带真实 output_tokens，先到的行是 0。
  // 四行塌成同一个 dedup_key，若沿用"先到者胜"，输出会被永久钉死在 0。
  const ccmrBlock = (out, stop) => JSON.stringify({
    timestamp: ISO(48000), type: 'assistant', sessionId: 's-ccmr',
    message: {
      id: 'm4', model: 'deepseek-flash', stop_reason: stop,
      usage: { input_tokens: 2000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: out },
    },
  });
  w(join(HOME, '.claude-gateway/projects/-work-projB/s-ccmr.jsonl'), [
    JSON.stringify({
      timestamp: ISO(50000), type: 'assistant', requestId: 'r2', sessionId: 's-ccmr',
      message: { id: 'm3', model: 'deepseek-flash', usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 200 } },
    }),
    ccmrBlock(0, null),        // thinking 块
    ccmrBlock(0, null),        // text 块
    ccmrBlock(500, 'end_turn'),// 终结块：唯一带真实输出的一行
  ]);

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

  // Pi：首行 session 带 cwd（project 唯一来源）+ 同 id 重复行 dedup + toolCall 块
  const piMsg = (id, tsIso, usage, extra = {}) => JSON.stringify({
    type: 'message', id, parentId: null, timestamp: tsIso,
    message: {
      role: 'assistant', api: 'openai-completions', provider: 'deepseek',
      model: 'Pi-Test-Model', timestamp: Date.parse(tsIso) - 1000, usage, ...extra,
    },
  });
  w(join(HOME, '.pi/agent/sessions/--work-projG--/2026-09-16T00-00-00-000Z_s-pi.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: 's-pi', timestamp: ISO(70000), cwd: '/work/projG' }),
    piMsg('p1', ISO(60000), { input: 300, output: 40, cacheRead: 1200, cacheWrite: 0, reasoning: 10, totalTokens: 1540 }),
    piMsg('p1', ISO(60000), { input: 300, output: 40, cacheRead: 1200, cacheWrite: 0, reasoning: 10, totalTokens: 1540 }), // 重复行 → dedup
    piMsg('p2', ISO(40000), { input: 100, output: 20, cacheRead: 0, cacheWrite: 50, reasoning: 0, totalTokens: 170 },
      { content: [{ type: 'toolCall', id: 'call_pi1', name: 'bash', arguments: '{}' }] }),
  ]);

  // OpenCode：sqlite（message.data.tokens 逐请求；part 的 tool 块 → 工具调用）
  const ocDir = join(HOME, '.local/share/opencode');
  mkdirSync(ocDir, { recursive: true });
  {
    const o = new DatabaseSync(join(ocDir, 'opencode.db'));
    o.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT)`);
    o.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    o.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)`);
    o.prepare(`INSERT INTO session VALUES ('s-oc', '/work/projH', 'title')`).run();
    // user 消息没有 tokens：必须跳过而不是记成 0 事件
    o.prepare(`INSERT INTO message VALUES ('oc-u1', 's-oc', ?, ?, ?)`)
      .run(NOW - 25000, NOW - 25000, JSON.stringify({ role: 'user', time: { created: NOW - 25000 } }));
    o.prepare(`INSERT INTO message VALUES ('oc-a1', 's-oc', ?, ?, ?)`)
      .run(NOW - 24000, NOW - 24000, JSON.stringify({
        role: 'assistant', modelID: 'Oc-Test-Model', providerID: 'prov', cost: 0,
        tokens: { total: 700, input: 200, output: 60, reasoning: 5, cache: { read: 400, write: 40 } },
        time: { created: NOW - 24000, completed: NOW - 23000 },
      }));
    o.prepare(`INSERT INTO part VALUES ('oc-p1', 'oc-a1', 's-oc', ?, ?, ?)`)
      .run(NOW - 23500, NOW - 23500, JSON.stringify({
        type: 'tool', tool: 'webfetch', callID: 'oc-call-1',
        state: { status: 'completed', time: { start: NOW - 23500, end: NOW - 23400 } },
      }));
    o.close();
  }

  // dsh：zstd 压缩的会话快照。v3 换了记录结构（assistant/chunk → assistant/message，
  // data.chunk.usage → data.usage），旧采集器一条也匹配不上且不报错——2026-08-14
  // 起整源静默归零。两种格式各造一份，确保新格式能解析且旧格式不被改坏。
  // 需要系统 zstd；缺失时该源在生产里本就整源跳过，测试同样跳过。
  const dshLines = (model, usageRec) => [
    JSON.stringify({ type: 'session', seq: 1, time: NOW - 22000, cwd: `/work/${model}` }),
    JSON.stringify({ type: 'request/header', seq: 2, time: NOW - 21500,
      data: { header: { config: { model: 'Dsh-Header-Model' } } } }),
    usageRec,
  ];
  // dsh 是**追加式多帧**写入：每批记录压成一个独立 zstd 帧接在文件末尾，实测单个会话
  // 文件里有数千帧。夹具必须照此生成——先前用单帧夹具，于是"只解第一帧"的实现一路绿灯，
  // 真实数据上却整源归零。夹具不像真实数据，测试就只是在测自己。
  const zstd = (dir, name, lines) => {
    mkdirSync(dir, { recursive: true });
    const zlib = require('node:zlib');
    if (typeof zlib.zstdCompressSync === 'function') {   // Node ≥ 23.8 自带
      const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n')));
      writeFileSync(join(dir, name), Buffer.concat(frames));
      return true;
    }
    // 旧版 Node：逐行压成独立帧再拼接，等价于上面的多帧布局
    const parts = lines.map((l, i) => {
      const plain = join(dir, `.part${i}`);
      writeFileSync(plain, l + '\n');
      const r = spawnSync('zstd', ['-q', '-f', plain, '-o', `${plain}.zst`], { encoding: 'utf8' });
      rmSync(plain, { force: true });
      return r.status === 0 ? readFileSync(`${plain}.zst`) : null;
    });
    if (parts.some((x) => !x)) return false;
    writeFileSync(join(dir, name), Buffer.concat(parts));
    for (let i = 0; i < lines.length; i++) rmSync(join(dir, `.part${i}.zst`), { force: true });
    return true;
  };
  // v3：usage 直接挂在 data 下，模型来自 data.message.source.model（覆盖 request/header）
  hasDsh = zstd(join(HOME, '.dsh/sessions/--work-projI--/s-dsh-v3'), 'session.v3.jsonl.zstd',
    dshLines('projI', JSON.stringify({
      type: 'assistant/message', seq: 3, time: NOW - 21000,
      data: {
        turn: 1, step: 1,
        usage: { inputTokens: 400, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 30, totalTokens: 1480 },
        message: { role: 'assistant', source: { kind: 'model', model: 'Dsh-Test-Model' } },
      },
    })));
  // 旧格式：与 v3 同目录也并存过，父目录名作 fileId 会让两者 dedup_key 撞车
  if (hasDsh) zstd(join(HOME, '.dsh/sessions/--work-projJ--/s-dsh-old'), 'session.jsonl.zstd',
    dshLines('projJ', JSON.stringify({
      type: 'assistant/chunk', seq: 3, time: NOW - 20500,
      data: { turn: 1, step: 1, chunk: { type: 'usage',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, reasoningTokens: 5 } } },
    })));

  // 本地定价（离线可算费用；deepseek/glm 覆盖 fixtures 模型）
  mkdirSync(join(HOME, '.tokenmeter'), { recursive: true });
  writeFileSync(join(HOME, '.tokenmeter', 'pricing.json'), JSON.stringify({
    usd_to_cny: 7.0,
    models: {
      'deepseek-v4.1-flash': { currency: 'CNY', input_miss: 2, input_hit: 0.4, output: 8 },
      'glm-5.3-flash': { currency: 'CNY', input_miss: 1, input_hit: 0.3, output: 4 },
      'gpt-test': { currency: 'CNY', input_miss: 10, input_hit: 2, output: 30 },
      'pi-test-model': { currency: 'CNY', input_miss: 3, input_hit: 0.6, output: 9 },
      'oc-test-model': { currency: 'CNY', input_miss: 5, input_hit: 1, output: 15 },
      'dsh-test-model': { currency: 'CNY', input_miss: 2, input_hit: 0.4, output: 8 },
      'dsh-header-model': { currency: 'CNY', input_miss: 2, input_hit: 0.4, output: 8 },
      // 只被第 6 节使用。故意不写 off_peak：老用户的 pricing.json 里没有这个字段，
      // 若实现成"缺失即不打折"，峰谷价对他们就是个静默空操作
      'deepseek-v4-pro': { currency: 'CNY', input_miss: 2000, input_hit: 0, output: 0 },
    },
  }));
}

// dsh 夹具是否落地，决定其黄金数字是否计入（无 zstd 时该源整体缺席）
const DSH_T = hasDsh ? 1800 : 0, DSH_N = hasDsh ? 2 : 0;

// 离线：回归测试不该依赖公网（汇率/LiteLLM 牌价），否则断网就跑不了、时长也不可控。
// USERPROFILE 是 Windows 上 os.homedir() 认的变量，只设 HOME 在那边临时家目录不生效。
const env = { ...process.env, HOME, USERPROFILE: HOME, TOKENMETER_OFFLINE: '1' };
const cli = (args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenwatcher.js'), ...args], { encoding: 'utf8', env });

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
  ok('ccmr 20700（多 block 响应取到终结块的输出）', byTool.ccmr?.t === 20700, JSON.stringify(byTool.ccmr));
  ok('ccmr 2 事件（4 行塌成 2 次调用）', byTool.ccmr?.n === 2, JSON.stringify(byTool.ccmr));
  // 这条是本次回归的靶心：网关不写 requestId 时曾把输出记成 0
  ok('ccmr 终结块输出 500 而非 0',
    q("SELECT output_tokens o FROM events WHERE tool='ccmr' ORDER BY output_tokens DESC")[0]?.o === 500,
    JSON.stringify(q("SELECT output_tokens o FROM events WHERE tool='ccmr'")));
  ok('codex 差分 280', byTool.codex?.t === 280, JSON.stringify(byTool.codex));
  ok('grok 2100（秒→毫秒换算）', byTool.grok?.t === 2100);
  ok('workbuddy 550', byTool.workbuddy?.t === 550);
  ok('zcode 860', byTool.zcode?.t === 860);
  // dsh v3：usage 挂在 data 下而非 data.chunk.usage；旧采集器在这里静默收零达一个月
  if (hasDsh) {
    ok('dsh 1800（v3 1480 + 旧格式 320）', byTool.dsh?.t === 1800, JSON.stringify(byTool.dsh));
    ok('dsh 2 事件（新旧格式各一，dedup_key 不撞车）', byTool.dsh?.n === 2, JSON.stringify(byTool.dsh));
    const v3 = q("SELECT * FROM events WHERE tool='dsh' AND total_tokens=1480")[0];
    ok('dsh v3 缓存写入 30（旧实现硬编码 0）', v3?.cache_write === 30, JSON.stringify(v3));
    ok('dsh v3 模型取 data.message.source.model', v3?.model === 'dsh-test-model', String(v3?.model));
    ok('dsh v3 project=projI（session.cwd）', v3?.project === 'projI', String(v3?.project));
    const old = q("SELECT * FROM events WHERE tool='dsh' AND total_tokens=320")[0];
    ok('dsh 旧格式仍可解析（模型回落 request/header）', old?.model === 'dsh-header-model', String(old?.model));
    ok('dsh 旧格式 reasoning 5 不重复计入 total', old?.reasoning_tokens === 5 && old?.total_tokens === 320,
      JSON.stringify(old));
  } else {
    console.log('  – dsh 断言跳过（系统无 zstd，该源在生产里同样整体跳过）');
  }
  // Pi/OpenCode 口径实测：total = 新输入 + 缓存读 + 缓存写 + 输出，reasoning 已含在 output 内。
  // 若误把 reasoning 再加一遍，pi 会变成 1550、opencode 会变成 705——这两个数就是防线。
  ok('pi 1710（input 不含缓存，reasoning 不重复计入）', byTool.pi?.t === 1710, JSON.stringify(byTool.pi));
  ok('pi 2 事件（同 id 重复行 dedup）', byTool.pi?.n === 2, JSON.stringify(byTool.pi));
  ok('opencode 700（user 消息无 tokens 不入库）', byTool.opencode?.t === 700, JSON.stringify(byTool.opencode));
  ok('opencode 1 事件', byTool.opencode?.n === 1, JSON.stringify(byTool.opencode));
  const total = Object.values(byTool).reduce((s, r) => s + r.t, 0);
  ok(`全源合计 ${27645 + DSH_T}`, total === 27645 + DSH_T, String(total));

  // 模型别名与归一
  const models = Object.fromEntries(q('SELECT model, COUNT(*) n FROM events GROUP BY model').map(r => [r.model, r.n]));
  ok("deepseek-flash → deepseek-v4.1-flash", models['deepseek-v4.1-flash'] === 2 && !models['deepseek-flash']);
  ok('GLM-5.3-Flash → glm-5.3-flash（小写归一）', models['glm-5.3-flash'] === 1);

  // 幂等：二次扫描不重复
  const n2 = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  ok(`事件总数 ${11 + DSH_N}（幂等）`, n2 === 11 + DSH_N, String(n2));

  // tool_calls
  const tc = Object.fromEntries(q('SELECT tool, COUNT(*) n FROM tool_calls GROUP BY tool').map(r => [r.tool, r.n]));
  ok('grok 工具调用 1', tc.grok === 1);
  ok('zcode 工具调用 1', tc.zcode === 1);
  ok('pi 工具调用 1（assistant 内容里的 toolCall 块）', tc.pi === 1, String(tc.pi));
  ok('opencode 工具调用 1（part 表 type=tool）', tc.opencode === 1, String(tc.opencode));

  // Codex 配额快照
  const quota = JSON.parse(db.prepare(`SELECT data FROM quota WHERE tool='codex'`).get()?.data ?? 'null');
  ok('codex 配额 42%', quota?.used_percent === 42 && quota?.plan_type === 'testplan');

  // project 捕获
  const proj = Object.fromEntries(q('SELECT tool, project FROM events GROUP BY tool').map(r => [r.tool, r.project]));
  ok('codex project=projC（session_meta 顶层 type）', proj.codex === 'projC');
  ok('grok project=projD（URL 解码）', proj.grok === 'projD');
  ok('zcode project=projF（session.directory）', proj.zcode === 'projF');
  // 目录名解项目名曾用 lastIndexOf('/') / split('/')，Windows 上分隔符是反斜杠会解错
  ok('workbuddy project=projE（目录名解析，跨平台分隔符）', proj.workbuddy === 'projE', String(proj.workbuddy));
  // Pi 的目录名把 / 换成了 -，无法可靠还原（daily-test 与 daily/test 同形）；
  // 唯一可信来源是首行 session 记录的 cwd，须由 collector state 带过增量轮次。
  ok('pi project=projG（首行 session.cwd，非目录名反推）', proj.pi === 'projG', String(proj.pi));
  ok('opencode project=projH（session.directory）', proj.opencode === 'projH', String(proj.opencode));
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
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenwatcher.js'), 'serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', d => { buf += d; });
  const started = await new Promise(r => { const t = setTimeout(() => r(false), 30000); child.stdout.on('data', () => { if (buf.includes('listening')) { clearTimeout(t); r(true); } }); });
  ok('serve 启动', started);

  if (started) {
    const res = await fetch(`http://127.0.0.1:${port}/api/summary?days=7`);
    const s = await res.json();
    ok('summary 200 且结构完整',
      res.status === 200 && s.totals?.all_time_tokens === 27645 + DSH_T && Array.isArray(s.by_day) && s.by_day.length >= 1
      && Array.isArray(s.health) && s.health.length === 9 && s.costs && Array.isArray(s.costs.by_day)
      && Array.isArray(s.recent) && s.recent.length === 11 + DSH_N,
      `totals=${s.totals?.all_time_tokens} health=${s.health?.length} recent=${s.recent?.length}`);
    // 健康表必须随注册表一起长——曾经它是一份硬编码工具清单，加源必漏
    ok('健康表覆盖全部注册源', s.health.length === SOURCES.length, `${s.health.length} vs ${SOURCES.length}`);
    const okTools = s.health.filter(h => h.status === 'ok').length;
    ok(`健康 ${hasDsh ? 9 : 8} 源 ok`, okTools === (hasDsh ? 9 : 8), `${okTools} ok`);
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

    // ECharts 拿不到 = app.js 在 echarts.init 处抛错 = 整页空白。1.2.0 就是这么坏的：
    // 路径写死成 <本包>/node_modules/echarts，而 npm 安装时 echarts 被提升到顶层。
    const ec = await fetch(`http://127.0.0.1:${port}/vendor/echarts.min.js`);
    ok('ECharts 能取到（取不到就整页空白）', ec.status === 200, String(ec.status));
    ok('ECharts 内容像是 JS 而非错误页',
      (ec.headers.get('content-type') || '').includes('javascript'), ec.headers.get('content-type'));
  }
  child.kill('SIGTERM');
}

/* ---------- 第 5 层：增量续写（Pi 的 project 必须跨轮次存活） ----------
 * Pi 的目录名把 '/' 换成了 '-'，无法反推项目名；project 的唯一可信来源是首行 session.cwd。
 * 而增量扫描是从字节游标往后读的——续写轮次根本读不到首行。若 project 不随 collector state
 * 落库，新事件就会是 project=null：面板上"按项目"从此漏掉这个源的新数据，且不报任何错。 */
console.log('\n[5] 增量续写');
{
  const piFile = join(HOME, '.pi/agent/sessions/--work-projG--/2026-09-16T00-00-00-000Z_s-pi.jsonl');
  appendFileSync(piFile, JSON.stringify({
    type: 'message', id: 'p3', timestamp: new Date().toISOString(),
    message: {
      role: 'assistant', model: 'Pi-Test-Model',
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 10 },
    },
  }) + '\n');

  const r = cli(['scan']);
  ok('续写后 scan 退出码 0', r.status === 0, r.stderr.slice(0, 200));

  const db = new DatabaseSync(dbFile, { readOnly: true });
  const row = db.prepare("SELECT project, total_tokens FROM events WHERE dedup_key = 'pi:s-pi:p3'").get();
  ok('续写事件已入库（字节游标继续推进）', row?.total_tokens === 10, JSON.stringify(row));
  ok('续写事件仍带 project（state 跨轮次存活，未退化为 null）', row?.project === 'projG', String(row?.project));
  ok('旧事件未被重复插入', db.prepare("SELECT COUNT(*) n FROM events WHERE tool = 'pi'").get().n === 3);
  db.close();
}

/* OpenCode 的 message/part 是 ON DELETE CASCADE，session 还带 revert 列——它会删消息。
 * SQLite 删掉最大 rowid 后会把该号让给下一条插入，于是新消息的 rowid 可能不大于水位，
 * 纯 rowid 水位会把它整条漏掉，且不报任何错。（ZCode 的 model_usage 只追加，没这个问题。） */
{
  const ocDb = join(HOME, '.local/share/opencode', 'opencode.db');
  {
    const o = new DatabaseSync(ocDb);
    o.exec("DELETE FROM message WHERE id = 'oc-a1'"); // 模拟一次 revert
    o.close();
  }
  ok('删行后 scan 退出码 0', cli(['scan']).status === 0);

  const newTs = Date.now();
  let reused;
  {
    const o = new DatabaseSync(ocDb);
    o.prepare(`INSERT INTO message VALUES ('oc-a2', 's-oc', ?, ?, ?)`).run(newTs, newTs, JSON.stringify({
      role: 'assistant', modelID: 'Oc-Test-Model',
      tokens: { total: 123, input: 100, output: 23, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: newTs },
    }));
    reused = o.prepare("SELECT rowid AS r FROM message WHERE id = 'oc-a2'").get().r;
    o.close();
  }
  ok('新消息确实复用了被删的 rowid（前提成立，才谈得上防护）', reused === 2, String(reused));
  ok('rowid 复用后 scan 退出码 0', cli(['scan']).status === 0);

  const db2 = new DatabaseSync(dbFile, { readOnly: true });
  ok('复用 rowid 的新消息没有被漏掉',
    db2.prepare("SELECT total_tokens t FROM events WHERE dedup_key = 'opencode:oc-a2'").get()?.t === 123,
    JSON.stringify(db2.prepare("SELECT dedup_key FROM events WHERE tool='opencode'").all()));
  ok('被删消息的历史事件仍保留（只读源消失不等于历史作废）',
    db2.prepare("SELECT COUNT(*) n FROM events WHERE dedup_key = 'opencode:oc-a1'").get().n === 1);
  db2.close();
}

/* ---------- 第 6 层：DeepSeek 峰谷价 ----------
 * 官方规则（api-docs.deepseek.com/quick_start/pricing，2026-09-16 核对）：
 *   峰时 = UTC 周一至周五 01:00-04:00 与 06:00-10:00；其余一切时段为谷时，谷时价减半。
 * 三个容易想当然的点，各自钉一条用例：按 UTC 不按本地时区、整个周末都是谷时、
 * 两段峰时之间 04:00-06:00 是空档。用固定时刻断言，否则结论随测试运行时刻漂移。
 */
console.log('\n[6] DeepSeek 峰谷价');
{
  const { PEAK_SQL } = await import(pathToFileURL(join(ROOT, 'src/pricing.js')).href);
  const mem = new DatabaseSync(':memory:');
  mem.exec('CREATE TABLE events (ts INTEGER)');
  const isPeak = (iso) => {
    mem.exec('DELETE FROM events');
    mem.prepare('INSERT INTO events VALUES (?)').run(Date.parse(iso));
    return mem.prepare(`SELECT ${PEAK_SQL} AS p FROM events`).get().p === 1;
  };
  // 2026-09-14 一 / 16 三 / 18 五 / 19 六 / 20 日
  const cases = [
    ['2026-09-16T00:59:00Z', false, '峰时窗口前一分钟'],
    ['2026-09-16T01:00:00Z', true,  '第一段峰时起点'],
    ['2026-09-16T03:59:00Z', true,  '第一段峰时末尾'],
    ['2026-09-16T04:00:00Z', false, '两段峰时之间的空档'],
    ['2026-09-16T05:59:00Z', false, '空档末尾'],
    ['2026-09-16T06:00:00Z', true,  '第二段峰时起点'],
    ['2026-09-16T09:59:00Z', true,  '第二段峰时末尾'],
    ['2026-09-16T10:00:00Z', false, '峰时窗口后'],
    ['2026-09-14T02:00:00Z', true,  '周一在峰时窗口内'],
    ['2026-09-18T07:00:00Z', true,  '周五在峰时窗口内'],
    ['2026-09-19T02:00:00Z', false, '周六即便在窗口时刻也是谷时'],
    ['2026-09-20T07:00:00Z', false, '周日即便在窗口时刻也是谷时'],
  ];
  for (const [iso, want, why] of cases) {
    ok(`${iso} ${want ? '峰' : '谷'}时（${why}）`, isPeak(iso) === want);
  }
  mem.close();

  // 折扣是否真的落到金额上：同样的 token 数，只有时刻不同
  const pdb = new DatabaseSync(dbFile);
  const ins = pdb.prepare(`INSERT OR IGNORE INTO events
    (ts, tool, model, session_id, project, input_tokens, cached_input, cache_write,
     output_tokens, reasoning_tokens, total_tokens, dedup_key)
    VALUES (?, 'ccmr', 'deepseek-v4-pro', 's-peak', 'projK', 1000, 0, 0, 0, 0, 1000, ?)`);
  ins.run(Date.parse('2026-09-16T02:00:00Z'), 'peak:1'); // 峰时 → 1000/1e6 × 2000 = ¥2
  ins.run(Date.parse('2026-09-16T05:00:00Z'), 'peak:2'); // 空档 → ¥1
  ins.run(Date.parse('2026-09-19T02:00:00Z'), 'peak:3'); // 周六 → ¥1
  pdb.close();

  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenwatcher.js'), 'serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', d => { buf += d; });
  const up = await new Promise(r => { const t = setTimeout(() => r(false), 30000); child.stdout.on('data', () => { if (buf.includes('listening')) { clearTimeout(t); r(true); } }); });
  ok('serve 启动（峰谷价）', up);
  if (up) {
    const s6 = await (await fetch(`http://127.0.0.1:${port}/api/summary?days=0`)).json();
    const m = s6.costs?.by_model?.find(x => x.model === 'deepseek-v4-pro');
    // 全按峰时算是 ¥6，正确应为 ¥2+¥1+¥1=¥4
    ok('谷时减半落到金额上（¥4 而非 ¥6）', m && Math.abs(m.cost_cny - 4) < 1e-9,
      JSON.stringify(m));
  }
  child.kill();
}

/* ---------- 第 7 层：无 zstd CLI 时仍能解 dsh ----------
 * 常驻服务由 launchd 拉起，其 PATH 是系统默认，不含 /opt/homebrew/bin，而 zstd 通常
 * 只装在那里。于是守护进程解不开 dsh 快照（报 "zstd not installed"），只有人在交互
 * shell 里手跑 scan 才正常——面板因此长期停在旧数据。清空 PATH 精确复现该环境。
 */
console.log('\n[7] 无 zstd CLI 时仍能解 dsh');
{
  const zlib = require('node:zlib');
  if (!hasDsh || typeof zlib.zstdDecompressSync !== 'function') {
    console.log('  – 跳过（无 dsh fixture 或该 Node 无内置 zstd，只能靠外部 CLI）');
  } else {
    const { collectDshFile } = await import(pathToFileURL(join(ROOT, 'src/collectors/dsh.js')).href);
    const events = [];
    const stub = { insertEvent: (e) => { events.push(e); return 1; }, insertToolCall: () => 1 };
    const fixture = join(HOME, '.dsh/sessions/--work-projI--/s-dsh-v3/session.v3.jsonl.zstd');
    const savedPath = process.env.PATH;
    process.env.PATH = '';   // launchd 环境：CLI 一律找不到
    let err = null;
    try {
      await collectDshFile(stub, { path: fixture, fileId: 's-dsh-v3' });
    } catch (e) { err = e; }
    finally { process.env.PATH = savedPath; }
    ok('PATH 里没有 zstd 也不抛错', !err, String(err?.message));
    ok('PATH 里没有 zstd 也能解出用量', events.length === 1 && events[0].total_tokens === 1480,
      JSON.stringify(events));
  }
}

/* ---------- 第 8 层：余额对账的归属 ----------
 * recon 把"账户余额掉了多少"和"我们算出花了多少"对比。它原先写死 tool='ccmr'，
 * 但 dsh 花的是同一个 DeepSeek 账户——于是永远显示巨大缺口，而缺口的一半是自己漏算的。
 * 与之相对，workbuddy 用 deepseek 模型但走自家积分、codex 是订阅制，都不扣这个 key，
 * 光按模型前缀放开又会多算。归属只能显式声明，不能从数据猜。
 */
console.log('\n[8] 余额对账的归属');
{
  const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
  const { computeRecon } = await import(pathToFileURL(join(ROOT, 'src/pricing.js')).href);
  const st = new Store(dbFile);
  const now = Date.now();
  st.db.exec(`DELETE FROM balance_history WHERE provider='deepseek'`);
  st.db.prepare('INSERT INTO balance_history VALUES (?,?,?)').run(now - 3_600_000, 'deepseek', 100);
  st.db.prepare('INSERT INTO balance_history VALUES (?,?,?)').run(now - 60_000, 'deepseek', 90);
  st.db.prepare(`INSERT OR REPLACE INTO quota (tool, ts, data) VALUES ('balance:deepseek', ?, ?)`)
    .run(now, JSON.stringify({ provider: 'DeepSeek', balance: 90, currency: 'CNY' }));

  // 对账窗口是"最近 N 小时"，必须相对 now 取时刻：写死日期的用例过一天就滑出窗口、自己变红。
  // 峰谷折扣由定价里显式的 off_peak: 1 关掉，而不是靠挑一个峰时时刻（周末根本没有峰时）。
  const ev = (tool, model, key) => st.insertEvent({
    ts: now - 30 * 60_000, tool, model, session_id: 's-recon', project: 'projR',
    input_tokens: 1_000_000, cached_input: 0, cache_write: 0, output_tokens: 0,
    reasoning_tokens: 0, total_tokens: 1_000_000, dedup_key: key,
  });
  ev('ccmr', 'deepseek-recon-test', 'recon:1');      // 计入：ccmr 扣该账户
  ev('dsh', 'deepseek-recon-test', 'recon:2');       // 计入：dsh 扣同一账户 ← 本次修的
  ev('workbuddy', 'deepseek-recon-test', 'recon:3'); // 不计：走自家积分
  ev('ccmr', 'deepseek/recon-test', 'recon:4');      // 不计：OpenRouter 形态，扣的是 OpenRouter

  // 只给测试模型定价，其余模型离线查不到价会被跳过，不干扰本节
  const pricing = { models: { 'deepseek-recon-test': { currency: 'CNY', input_miss: 2, input_hit: 0, output: 0, off_peak: 1 } } };
  const r = computeRecon(st.db, st, pricing, { hours: 24, rate: 7 })
    .find(x => x.id === 'deepseek');
  ok('对账覆盖同账户的全部工具（ccmr+dsh=¥4，非仅 ccmr 的 ¥2）',
    r && Math.abs(r.spend - 4) < 1e-9, JSON.stringify(r));
  ok('余额差值照常读出（-10）', r && Math.abs(r.delta + 10) < 1e-9, String(r?.delta));
  st.db.close();
}

/* ---------- 第 9 层：LaunchAgent 生成 ----------
 * 全局安装的用户没有仓库，npm scripts 也调不到，此前没有可用的常驻方案。
 * 这里只验"生成"，绝不调用 launchctl——否则跑一次测试就在开发机上装出一个真服务。
 */
console.log('\n[9] LaunchAgent 生成');
{
  const { buildPlist, entryScript, AGENT_LABEL } = await import(pathToFileURL(join(ROOT, 'src/agent.js')).href);

  const plist = buildPlist({ node: '/usr/local/bin/node', script: '/opt/pkg/bin/tokenwatcher.js', port: 9001, logDir: '/tmp/l' });
  // launchd 的 PATH 是系统默认，不含 npm 全局 bin 也不含 homebrew；脚本 shebang 又是
  // #!/usr/bin/env node。所以 node 与脚本都必须是生成时就固化的绝对路径。
  ok('plist 固化 node 绝对路径', plist.includes('<string>/usr/local/bin/node</string>'));
  ok('plist 固化入口脚本绝对路径', plist.includes('<string>/opt/pkg/bin/tokenwatcher.js</string>'));
  ok('plist 带上端口', plist.includes('<string>--port</string>') && plist.includes('<string>9001</string>'));
  ok('plist 含 serve 与 KeepAlive', plist.includes('<string>serve</string>') && plist.includes('<key>KeepAlive</key>'));
  ok('plist 标签与文件名一致', plist.includes(`<string>${AGENT_LABEL}</string>`));

  // 家目录含 & 的用户并不罕见（公司名、姓氏）。不转义会生成非法 XML，
  // launchd 静默拒绝加载——又是一个"不报错只是不工作"的失败方式。
  const nasty = buildPlist({ node: '/n/a&b/node', script: '/s/x<y>/t.js', port: 8787, logDir: '/l/&' });
  ok('路径中的 XML 特殊字符被转义',
    nasty.includes('/n/a&amp;b/node') && nasty.includes('/s/x&lt;y&gt;/t.js') && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(nasty),
    nasty.match(/<string>[^<]*[&<][^<]*<\/string>/g)?.join(' | '));

  if (process.platform === 'darwin') {
    const f = join(HOME, 'probe.plist');
    writeFileSync(f, nasty);
    const lint = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' });
    ok('生成的 plist 能过系统 plutil 校验', lint.status === 0, lint.stdout + lint.stderr);
  } else {
    console.log('  – plutil 校验跳过（非 macOS）');
  }

  const entry = entryScript();
  ok('入口脚本解析到真实存在的文件', existsSync(entry) && entry.endsWith('bin/tokenwatcher.js'), entry);

  // 装卸服务与数据无关。若排在 new Store 之后，仅仅装个开机自启就会在用户机器上
  // 建出数据库文件——这种副作用没人会想到要去测，只能靠顺序锁住。
  const cliSrc = read(join(ROOT, 'bin/tokenwatcher.js'));
  ok('装卸服务在创建 Store 之前分流',
    cliSrc.indexOf("cmd === 'install-agent'") < cliSrc.indexOf('new Store(DB_PATH)'));
  // README 曾指向 npm run install-agent，而全局安装的用户根本调不到 npm scripts
  ok('README 用 CLI 子命令而非 npm script 指引常驻',
    /token-watcher install-agent|tokenwatcher install-agent/.test(read(join(ROOT, 'README.md'))));
}

/* ---------- 第 10 层：菜单栏胶囊的分发 ----------
 * 此前 .app 只存在于仓库、且不在 files 白名单里，`npm i -g` 的用户拿不到，
 * 而 README 指的 `npm run bar` 对全局安装同样不可见。这类"声明了但没发出去"
 * 的缺陷装包前看不出来，只能在 npm pack 的实际产物上验。
 */
console.log('\n[10] 菜单栏胶囊的分发');
{
  const { barAppPath } = await import(pathToFileURL(join(ROOT, 'src/bar.js')).href);
  ok('app 路径解析在包内', barAppPath().endsWith(join('bin', 'token-watcher.app')), barAppPath());

  // 发布白名单必须声明它。产物本身不入 git（由 prepack 在发版前编译），
  // 所以干净克隆与 Linux CI 上盘里没有 .app，那种情况下只能验声明。
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  ok('files 白名单声明了菜单栏 app', (pkg.files || []).includes('bin/token-watcher.app/'),
    JSON.stringify(pkg.files));
  ok('prepack 会在发版前编译，避免发出陈旧或缺失的产物',
    /build.sh/.test(pkg.scripts?.prepack || ''), pkg.scripts?.prepack);

  const exe = join(barAppPath(), 'Contents', 'MacOS', 'token-watcher');
  if (existsSync(exe)) {
    // 光声明不够：曾经 files 里写了却因为路径写法不对而没进包
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: ROOT, encoding: 'utf8' });
    let files = [];
    try { files = JSON.parse(packed.stdout)[0].files.map((f) => f.path); } catch { /* 断言会报错 */ }
    ok('声明的 app 确实进了发布产物',
      files.some((f) => f.endsWith('token-watcher.app/Contents/MacOS/token-watcher'))
      && files.some((f) => f.endsWith('token-watcher.app/Contents/Info.plist')),
      files.filter((f) => f.includes('.app')).join(',') || packed.stderr?.slice(0, 120));
  } else {
    console.log('  – 打包内容检查跳过（本地尚未编译 app，执行 npm run build-bar 后可验）');
  }

  // Intel Mac 上单 arm64 产物直接无法运行，且失败时没有任何提示
  if (process.platform === 'darwin' && existsSync(exe)) {
    const archs = spawnSync('lipo', ['-archs', exe], { encoding: 'utf8' }).stdout || '';
    ok('二进制为 universal（含 arm64 与 x86_64）',
      archs.includes('arm64') && archs.includes('x86_64'), archs.trim());
  } else {
    console.log('  – 架构检查跳过（非 macOS 或尚未编译）');
  }

  const cliSrc = read(join(ROOT, 'bin/tokenwatcher.js'));
  ok('bar 在创建 Store 之前分流', cliSrc.indexOf("cmd === 'bar'") < cliSrc.indexOf('new Store(DB_PATH)'));
  // 写死端口会让 serve --port 的用户拿到一个连不上的胶囊
  ok('菜单栏源码不再写死端口', !/127\.0\.0\.1:8787/.test(read(join(ROOT, 'menubar/main.swift'))));
  ok('README 用 CLI 子命令指引菜单栏',
    /token-watcher bar|tokenwatcher bar/.test(read(join(ROOT, 'README.md'))));
}

/* ---------- 清理 ---------- */
rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);

function read(p) { return readFileSync(p, 'utf8'); }
import { readFileSync } from 'node:fs';
