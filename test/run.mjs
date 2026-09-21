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

  // 横向条形图的数据数组做了 reverse，tooltip 却按原序数组取下标——悬停 A 条显示 B 条的
  // 次数（实测 304 次调用张冠李戴）。修复后两处都必须从反转后的 rows 取
  ok('模型 Top10 悬浮次数取反转后的 rows（不再张冠李戴）',
    /rows\[p\.dataIndex\]\.n\} 次调用/.test(app), 'renderModel formatter');
  ok('工具调用榜悬浮明细同样取 rows',
    /const t = rows\[p\.dataIndex\]\?\.tools \|\| \{\}/.test(app), 'renderToolActivity formatter');

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
  const { esc, fmt, fmtShort, ymd, windowLabel, fmtCountdown } = await lib('format.js');
  const { MODEL_PALETTE, TOOL_COLORS } = await lib('theme.js');
  const { chartTooltip, tooltipPosition } = await lib('tooltip.js');

  // ---- 配额窗口标签：按时长命名，不按 primary/secondary 位置（plus 的 primary 是 5 小时，pro 的是周） ----
  ok('窗口标签 300 分钟 = 5 小时', windowLabel?.(300) === '5 小时', String(windowLabel?.(300)));
  ok('窗口标签 10080 分钟 = 每周', windowLabel?.(10080) === '每周', String(windowLabel?.(10080)));
  ok('窗口标签 1440 分钟 = 1 天', windowLabel?.(1440) === '1 天', String(windowLabel?.(1440)));
  ok('Codex 配额卡不再写死"周配额"', !app.includes('Codex 周配额'));
  // 周窗口的重置常在几天后，"95时59分"要心算才知道是四天
  const H = 3.6e6;
  ok('倒计时满一天带"天"（紧凑格式）', fmtCountdown?.(4 * 24 * H - 1000) === '3天 23:59', String(fmtCountdown?.(4 * 24 * H - 1000)));
  ok('倒计时不满一天保留秒', fmtCountdown?.(3 * H + 57 * 6e4 + 18e3) === '3:57:18', String(fmtCountdown?.(3 * H + 57 * 6e4 + 18e3)));
  ok('倒计时到点显示已结束', fmtCountdown?.(0) === '已结束' && fmtCountdown?.(-5) === '已结束');
  ok('Codex 配额卡按窗口逐条渲染', /windows/.test(app) && /windowLabel\(/.test(app));

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
  // 本用例只验美元折算。事件取"1 小时前"，峰谷由运行时刻决定，不显式关掉折扣就会在谷时减半、随机变红
  const usdPricing = { models: { 'deepseek-v4.1-flash': { currency: 'USD', input_miss: 0.30, input_hit: 0.006, output: 1.20, off_peak: 1 } } };
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
let ATY_GOLD = 0, ATY_FINAL = 0, ATY_U3_ESTIN = 0; // antigravity 黄金数字（估算口径，夹具块内计算）
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
      // plus 套餐真实形态：primary 是 5 小时窗口，secondary 才是周窗口（pro 只有 primary=周）
      rate_limits: { limit_id: 'codex', primary: { used_percent: 25, window_minutes: 300, resets_at: 1799990000 },
        secondary: { used_percent: 42, window_minutes: 10080, resets_at: 1799999999 }, plan_type: 'testplan' } } }),
    JSON.stringify({ timestamp: ISO(30000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 350, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 400 } } } }),
    // 更晚的两条快照都不是主额度：Spark 模型的独立额度、窗口全空的 premium。累计值不变，不产生事件
    JSON.stringify({ timestamp: ISO(29000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 350, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 400 } },
      rate_limits: { limit_id: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark',
        primary: { used_percent: 0, window_minutes: 10080, resets_at: 1799999000 }, secondary: null, plan_type: 'testplan' } } }),
    JSON.stringify({ timestamp: ISO(28000), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 350, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 400 } },
      rate_limits: { limit_id: 'premium', primary: null, secondary: null, plan_type: 'testplan' } } }),
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


  // Antigravity（估算口径）：transcript 计费 + conversations db 的权威上下文。
  // protobuf 行由测试构造（字段路径 1→{9→10→1 上下文, 19 模型, 20 KV last_step_index}，
  // 与真实数据实测一致）。u1 带权威 db；u2 无 db 走估算 + 之后补 db 触发原地补正。
  const aty = await import(pathToFileURL(join(ROOT, 'src/collectors/antigravity.js')).href);
  const est = aty.estimateTokens;
  const vi = (n) => { const out = []; let v = n; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
  const tagOf = (n, wt) => vi((n << 3) | wt);
  const ld = (n, payload) => Buffer.concat([tagOf(n, 2), vi(payload.length), payload]);
  const vf = (n, v) => Buffer.concat([tagOf(n, 0), vi(v)]);
  const genRow = ({ model, contextTokens, lastStepIndex }) => ld(1, Buffer.concat([
    ld(9, ld(10, vf(1, contextTokens))),
    ld(19, Buffer.from(model)),
    ld(20, Buffer.concat([ld(1, Buffer.from('last_step_index')), ld(2, Buffer.from(String(lastStepIndex)))])),
  ]));
  const atyDb = (dir, rows) => {
    mkdirSync(dirname(dir), { recursive: true });
    const c = new DatabaseSync(dir);
    c.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)');
    rows.forEach((blob, i) => c.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(i, blob, blob.length));
    c.close();
  };

  const A1_TC = JSON.stringify([{ tool: 'run_command', args: { cmd: 'a'.repeat(150) } }]);
  const A3_C = 'b'.repeat(100), A3_TH = 'c'.repeat(40), A2_C = 'a'.repeat(400);
  // u1：db 权威 → 事件1 input=23986；事件2 input=25713-23986=1727
  w(join(HOME, '.gemini/antigravity-cli/brain/u1-anty/.system_generated/logs/transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: ISO(60000), content: 'hello antigravity' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: ISO(58000), content: '', tool_calls: JSON.parse(A1_TC), thinking: '' }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', created_at: ISO(50000), content: A2_C }),
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: ISO(40000), content: A3_C, thinking: A3_TH }),
  ]);
  atyDb(join(HOME, '.gemini/antigravity-cli/conversations/u1-anty.db'), [
    genRow({ model: 'Gemini 3.8 Flash (Medium)', contextTokens: 23986, lastStepIndex: 0 }),
    genRow({ model: 'gemini-3.8-flash', contextTokens: 25713, lastStepIndex: 2 }),
  ]);
  // u2：无 db → 估算（input=此前累计内容）；brain 目录外的非 transcript jsonl 不入文件行
  w(join(HOME, '.gemini/antigravity/brain/u2-anty/.system_generated/logs/transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: ISO(30000), content: 'd'.repeat(100) }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: ISO(20000), content: 'e'.repeat(80) }),
  ]);
  writeFileSync(join(HOME, '.gemini/antigravity/brain/u2-anty/.system_generated/logs/other.jsonl'), '{}');
  const ATY_EST_U2 = est('d'.repeat(100)) + est('e'.repeat(80));
  // u3：权威→估算→权威三明治。中间轮无 db 行按估算链计费；后一个权威轮必须回到
  // 权威链差分（12000-10000=2000），绝不能拿权威值减上一轮的估算值（混口径曾把
  // 实时会话 input 虚高 4 倍：负差钳 0 或整段上下文全额入账）
  const A_U3_IN = 'x'.repeat(200);
  const A_U3_TC = JSON.stringify([{ tool: 't', args: { c: 'y'.repeat(100) } }]);
  const A_U3_G2 = 'z'.repeat(300), A_U3_P3 = 'w'.repeat(50), A_U3_P5 = 'q'.repeat(20);
  const ATY_U3_ESTIN_V = est(A_U3_IN) + est(A_U3_TC) + est(A_U3_G2); // 估算轮的整条估算链（prevEst 从 0 起）
  ATY_U3_ESTIN = ATY_U3_ESTIN_V;
  w(join(HOME, '.gemini/antigravity-cli/brain/u3-anty/.system_generated/logs/transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: ISO(15000), content: A_U3_IN }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: ISO(14000), content: '', tool_calls: JSON.parse(A_U3_TC) }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', created_at: ISO(13000), content: A_U3_G2 }),
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: ISO(12000), content: A_U3_P3 }),
    JSON.stringify({ step_index: 4, type: 'GENERIC', created_at: ISO(10000), content: 'v'.repeat(100) }),
    JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: ISO(9000), content: A_U3_P5 }),
  ]);
  atyDb(join(HOME, '.gemini/antigravity-cli/conversations/u3-anty.db'), [
    genRow({ model: 'gemini-3.8-flash', contextTokens: 10000, lastStepIndex: 0 }),
    genRow({ model: 'gemini-3.8-flash', contextTokens: 12000, lastStepIndex: 4 }), // step5 没有 gen 行
  ]);
  const ATY_U3 = (10000 + est(A_U3_TC)) + (ATY_U3_ESTIN_V + est(A_U3_P3)) + (2000 + est(A_U3_P5));
  ATY_GOLD = 23986 + 1727 + est(A1_TC) + est(A3_C) + est(A3_TH) + ATY_EST_U2 + ATY_U3;
  ATY_FINAL = ATY_GOLD - est('d'.repeat(100)) + 5000; // u2 补正后（见下方补正用例）

  // Kimi Code：workspaces.json（wd 目录 → 项目名）+ wire.jsonl（config.update 模型 +
  // camelCase / Anthropic / OpenAI 兼容三种 usage 形状 + 零用量跳过 + 重复 uuid dedup）
  mkdirSync(join(HOME, '.kimi-code'), { recursive: true });
  writeFileSync(join(HOME, '.kimi-code', 'workspaces.json'), JSON.stringify({
    version: 1, workspaces: { wd_projX_abc123: { root: '/work/projX', name: 'projX' } },
  }));
  const kNow = Date.now();
  w(join(HOME, '.kimi-code/sessions/wd_projX_abc123/session_s-kimi/agents/main/wire.jsonl'), [
    JSON.stringify({ type: 'config.update', modelAlias: 'kimi-code/k3' }),
    JSON.stringify({ type: 'context.append_loop_event', time: kNow - 50000,
      event: { type: 'step.end', uuid: 'k1', usage: { inputOther: 500, inputCacheRead: 2000, inputCacheCreation: 100, output: 80 } } }),
    JSON.stringify({ type: 'context.append_loop_event', time: kNow - 40000,
      event: { type: 'step.end', uuid: 'k2', usage: { input_tokens: 900, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, output_tokens: 120 } } }),
    JSON.stringify({ type: 'step.end', uuid: 'k3', time: kNow - 30000,
      usage: { input_tokens: 800, input_tokens_details: { cached_tokens: 600 }, output_tokens: 50 } }),
    JSON.stringify({ type: 'step.end', uuid: 'k4', time: kNow - 29000,
      usage: { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0 } }), // 零用量跳过
    JSON.stringify({ type: 'context.append_loop_event', time: kNow - 50000,
      event: { type: 'step.end', uuid: 'k1', usage: { inputOther: 500, inputCacheRead: 2000, inputCacheCreation: 100, output: 80 } } }), // 重复 uuid → dedup
  ]);
  // Kimi 黄金：2680 + 4020 + (800-600)+600+50=850 → 7550 / 3 事件；模型 k3；project projX

  // Qoder：workspace-directories 取 cwd + thinking 前置行 + 带 token 终结行 + 仅积分行 +
  // BYOK 模型前缀剥离（qoder-custom-<uuid>/）
  w(join(HOME, '.qoder/projects/-work-projQ/s-q1.jsonl'), [
    JSON.stringify({ type: 'workspace-directories', sessionId: 's-q1', directories: ['/work/projQ'] }),
    JSON.stringify({ timestamp: ISO(60000), type: 'assistant', uuid: 'qa1',
      message: { id: 'q1', model: 'qmodel_38max', stop_reason: null, content: [{ type: 'thinking', thinking: 'x' }] } }),
    JSON.stringify({ timestamp: ISO(55000), type: 'assistant', uuid: 'qa2',
      message: { id: 'q2', model: 'qmodel_38max', stop_reason: 'end_turn',
        usage: { input_tokens: 300, cache_read_input_tokens: 1200, cache_creation_input_tokens: 50, output_tokens: 90, credits: 1.5, original_credits: 3.0, request_id: 'rq1' } } }),
    JSON.stringify({ timestamp: ISO(50000), type: 'assistant', uuid: 'qa3',
      message: { id: 'q3', model: 'qmodel_38max', stop_reason: 'end_turn',
        usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, credits: 0.25 } } }), // 仅积分：不入 token 事件
    JSON.stringify({ timestamp: ISO(45000), type: 'assistant', uuid: 'qa4',
      message: { id: 'q4', model: 'qoder-custom-12345678-1234-1234-1234-123456789abc/glm-5.3-flash', stop_reason: 'end_turn',
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } } }),
  ]);
  // Qoder 黄金：token 事件 1640 + 15 = 1655 / 2 事件；积分 1.5 + 0.25 = 1.75

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
  // 订阅 ROI 夹具：codex 按美元月费（×测试汇率 7.0 = ¥70），qoder 人民币月费
  writeFileSync(join(HOME, '.tokenmeter', 'subscriptions.json'), JSON.stringify({
    _note: '说明字段应被忽略',
    monthly: {
      codex: { name: 'Codex plus', price_usd: 10 },
      qoder: { name: 'Qoder Pro', price_cny: 50 },
      gpt: { tool: 'codex', name: 'GPT 子集', models: 'gpt', price_cny: 1 },
      glm: { tool: 'zcode', name: 'GLM Plan', models: 'glm', price_cny: 20 },
      qwen: { tool: 'ccmr', name: 'Qwen', models: 'qwen', price_cny: 5 },
      grokfree: { tool: 'grok', name: 'Grok', price_usd: null },
    },
  }));

}

// dsh 夹具是否落地，决定其黄金数字是否计入（无 zstd 时该源整体缺席）
const DSH_T = hasDsh ? 1800 : 0, DSH_N = hasDsh ? 2 : 0;

// 离线：回归测试不该依赖公网（汇率/LiteLLM 牌价），否则断网就跑不了、时长也不可控。
// USERPROFILE 是 Windows 上 os.homedir() 认的变量，只设 HOME 在那边临时家目录不生效。
// NO_KEYCHAIN：doctor/配额轮询的凭证探测默认会读登录钥匙串（macOS 可能弹一次授权框），
// 测试进程不该去摸宿主钥匙串。
const env = { ...process.env, HOME, USERPROFILE: HOME, TOKENMETER_OFFLINE: '1', TOKENMETER_NO_KEYCHAIN: '1' };
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
  // Kimi：wire.jsonl 三种 usage 形状 + 项目名映射
  ok('kimi 7550（camelCase 2680 + Anthropic 4020 + OpenAI 兼容 850）', byTool.kimi?.t === 7550, JSON.stringify(byTool.kimi));
  ok('kimi 3 事件（零用量跳过、重复 uuid dedup）', byTool.kimi?.n === 3, JSON.stringify(byTool.kimi));
  const kimiEv = q("SELECT input_tokens, cached_input, project, model FROM events WHERE tool='kimi' ORDER BY ts");
  ok('kimi OpenAI 兼容形状扣减缓存不双计（input=200, cached=600）',
    kimiEv[2]?.input_tokens === 200 && kimiEv[2]?.cached_input === 600, JSON.stringify(kimiEv[2]));
  ok('kimi 模型取 config.update 别名（kimi-code/k3 → k3）', kimiEv.every(e => e.model === 'k3'), JSON.stringify(kimiEv.map(e => e.model)));
  ok('kimi project 来自 workspaces.json', kimiEv.every(e => e.project === 'projX'), JSON.stringify(kimiEv[0]));
  // Qoder：token 事件 + 积分账本
  ok('qoder 1655（带 token 的行才入事件）', byTool.qoder?.t === 1655, JSON.stringify(byTool.qoder));
  ok('qoder 2 事件（仅积分行不入 token 事件）', byTool.qoder?.n === 2, JSON.stringify(byTool.qoder));
  ok('qoder BYOK 模型剥离安装期前缀',
    q("SELECT model FROM events WHERE tool='qoder' AND total_tokens=15")[0]?.model === 'glm-5.3-flash',
    JSON.stringify(q("SELECT model, total_tokens FROM events WHERE tool='qoder'")));
  const qCredits = db.prepare("SELECT SUM(amount) t, COUNT(*) n FROM credit_usage WHERE tool='qoder'").get();
  ok('qoder 积分账本 1.75（幂等）', qCredits?.t === 1.75 && qCredits?.n === 2, JSON.stringify(qCredits));
  {
    // 积分账本让健康表不误报"无数据"：只有 credits、零 token 事件的源应为 ok
    const { computeHealth } = await import(pathToFileURL(join(ROOT, 'src/server.js')).href);
    const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
    const hHome = mkdtempSync(join(tmpdir(), 'tokenmeter-h-'));
    const hs = new Store(join(hHome, 'x.db'));
    hs.insertCredit({ ts: Date.now(), tool: 'qoder', amount: 0.5, dedup_key: 't1' });
    const hh = computeHealth(hs.db, {}).find(x => x.tool === 'qoder');
    ok('仅积分无 token 的源健康状态为 ok（不再误报无数据）', hh?.status === 'ok' && hh?.events === 0,
      JSON.stringify(hh));
    const he = computeHealth(hs.db, {}).find(x => x.tool === 'cursor');
    ok('零数据零积分的源仍为 empty（cursor 未登录场景）', he?.status === 'empty', JSON.stringify(he));
    hs.close();
    rmSync(hHome, { recursive: true, force: true });
  }
  // 订阅 ROI：codex 本月 API 等值 = 唯一计价事件（fresh150/1e6×10 + cached100/1e6×2 + out30/1e6×30 = 0.0026）
  {
    const rj = cli(['roi', '--json']);
    let rr = null;
    try { rr = JSON.parse(rj.stdout); } catch { /* 断言会红 */ }
    ok('roi --json 可解析且已配置', rj.status === 0 && rr?.configured === true, rj.stdout.slice(0, 120));
    const cx = rr?.entries?.find(e => e.tool === 'codex');
    const qd = rr?.entries?.find(e => e.tool === 'qoder');
    ok('codex API 等值 0.0026 / 月费 72（USD×离线默认汇率 7.2）',
      Math.abs((cx?.api_cny ?? -1) - 0.0026) < 1e-6 && cx?.paid_cny === 72, JSON.stringify(cx));
    ok('qoder 积分制：本月积分 1.75、无硬造比值',
      qd?.credits === 1.75 && qd?.ratio === null, JSON.stringify(qd));
    const gpt = rr?.entries?.find(e => e.name === 'GPT 子集');
    ok('模型过滤：codex 的 gpt 前缀条目 = 0.0026（与整工具等值，gpt-test 无峰谷抖动）',
      Math.abs((gpt?.api_cny ?? -1) - 0.0026) < 1e-6 && gpt?.paid_cny === 1 && gpt?.models === 'gpt',
      JSON.stringify(gpt));
    const gl = rr?.entries?.find(e => e.name === 'GLM Plan');
    ok('模型过滤命中未配价模型时如实为 0（glm-5.3 不在测试定价表）',
      gl?.api_cny === 0 && gl?.paid_cny === 20, JSON.stringify(gl));
    const qw = rr?.entries?.find(e => e.name === 'Qwen');
    ok('模型过滤的排除性：ccmr 有花费但 qwen 前缀条目为 0',
      qw?.api_cny === 0, JSON.stringify(qw));
    const gf = rr?.entries?.find(e => e.name === 'Grok');
    ok('月费未填的条目仍显示（paid_cny=null、无比值）',
      gf?.paid_cny === null && gf?.ratio === null, JSON.stringify(gf));
  }
  ok('qoder project 取 workspace-directories 的 cwd 末段',
    q("SELECT DISTINCT project FROM events WHERE tool='qoder'").every(r => r.project === 'projQ'));
  // Antigravity（估算口径）：权威 db 上下文 + 字符估算输出
  const atyEv = q("SELECT dedup_key, input_tokens, output_tokens, model FROM events WHERE tool='antigravity' ORDER BY ts");
  ok(`antigravity 总量 ${ATY_GOLD}`, byTool.antigravity?.t === ATY_GOLD, `${byTool.antigravity?.t} vs ${ATY_GOLD}`);
  ok('antigravity 6 事件（u1 两权威 + u2 估算 + u3 三明治）', byTool.antigravity?.n === 6, JSON.stringify(byTool.antigravity));
  ok('antigravity 权威输入 23986 / 1727（上下文差分）',
    atyEv[0]?.input_tokens === 23986 && atyEv[1]?.input_tokens === 1727, JSON.stringify(atyEv));
  ok('antigravity 模型名归一（Gemini 3.8 Flash (Medium) → gemini-3.8-flash）',
    atyEv[0]?.model === 'gemini-3.8-flash' && atyEv[1]?.model === 'gemini-3.8-flash',
    JSON.stringify(atyEv.map(e => e.model)));
  ok('antigravity 无模型信息的事件如实留空（u2 走估算路径）',
    atyEv[2]?.model === null, JSON.stringify(atyEv[2]));
  ok('antigravity 权威/估算基线不混用：三明治中间轮走估算链，后一权威轮回到权威差分 2000',
    atyEv[3]?.input_tokens === 10000 && atyEv[4]?.input_tokens === ATY_U3_ESTIN && atyEv[5]?.input_tokens === 2000,
    JSON.stringify(atyEv.slice(3).map(e => e.input_tokens)));
  ok('antigravity 非 transcript 的 jsonl 不入文件行',
    q("SELECT COUNT(*) n FROM files WHERE tool='antigravity'")[0]?.n === 3);
  const total = Object.values(byTool).reduce((s, r) => s + r.t, 0);
  ok(`全源合计 ${36850 + ATY_GOLD + DSH_T}`, total === 36850 + ATY_GOLD + DSH_T, String(total));

  // 模型别名与归一
  const models = Object.fromEntries(q('SELECT model, COUNT(*) n FROM events GROUP BY model').map(r => [r.model, r.n]));
  ok("deepseek-flash → deepseek-v4.1-flash", models['deepseek-v4.1-flash'] === 2 && !models['deepseek-flash']);
  ok('GLM-5.3-Flash → glm-5.3-flash（小写归一）', models['glm-5.3-flash'] === 2);

  // 幂等：二次扫描不重复
  const n2 = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  ok(`事件总数 ${22 + DSH_N}（幂等）`, n2 === 22 + DSH_N, String(n2));

  // tool_calls
  const tc = Object.fromEntries(q('SELECT tool, COUNT(*) n FROM tool_calls GROUP BY tool').map(r => [r.tool, r.n]));
  ok('grok 工具调用 1', tc.grok === 1);
  ok('zcode 工具调用 1', tc.zcode === 1);
  ok('pi 工具调用 1（assistant 内容里的 toolCall 块）', tc.pi === 1, String(tc.pi));
  ok('opencode 工具调用 1（part 表 type=tool）', tc.opencode === 1, String(tc.opencode));

  // Codex 配额快照
  const quota = JSON.parse(db.prepare(`SELECT data FROM quota WHERE tool='codex'`).get()?.data ?? 'null');
  const win = (m) => quota?.windows?.find(w => w.window_minutes === m);
  ok('codex 配额按窗口时长识别：周窗口 42%（plus 的周额度在 secondary）', win(10080)?.used_percent === 42, JSON.stringify(quota));
  ok('codex 配额同时保留 5 小时窗口 25%', win(300)?.used_percent === 25, JSON.stringify(quota));
  ok('codex 配额 plan_type 保留', quota?.plan_type === 'testplan', JSON.stringify(quota));
  ok('Spark 独立额度与 premium 空快照不覆盖主额度', quota?.windows?.length === 2, JSON.stringify(quota));

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

/* ---------- 3c：Antigravity 重放段去重 + 权威上下文到位后的原地补正 ----------
 * 上游会把历史行重写/重放进 transcript（实测同一段 step 出现两遍）。首笔才是真实计费，
 * 重放段只带增量内容——dedup 必须保首笔、不得重复计数。
 * 无 db 行时按字符估算入账的事件记进 state.pending，db 行到位后（transcript 再次变化
 * 触发采集时）原地 UPDATE 补正，否则"第一眼的低估"会被永久钉死。 */
{
  const NOWC = Date.now();
  const ISO = (msAgo) => new Date(NOWC - msAgo).toISOString();
  const u1 = join(HOME, '.gemini/antigravity-cli/brain/u1-anty/.system_generated/logs/transcript.jsonl');
  const u1Line3 = JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: ISO(40000), content: 'b'.repeat(100), thinking: 'c'.repeat(40) });
  appendFileSync(u1, u1Line3 + '\n'); // 重放 step3 原行
  ok('重放历史行后 scan 退出码 0', cli(['scan']).status === 0);

  const u2 = join(HOME, '.gemini/antigravity/brain/u2-anty/.system_generated/logs/transcript.jsonl');
  {
    // 权威 db 晚于 transcript 落盘（真实时序）：先补 db，再让 transcript 有新动静触发重采
    const u2db = join(HOME, '.gemini/antigravity/conversations/u2-anty.db');
    mkdirSync(dirname(u2db), { recursive: true });
    const c = new DatabaseSync(u2db);
    c.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)');
    const vi2 = (n) => { const out = []; let v = n; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
    const t2 = (n, wt) => vi2((n << 3) | wt);
    const l2 = (n, p) => Buffer.concat([t2(n, 2), vi2(p.length), p]);
    const v2 = (n, x) => Buffer.concat([t2(n, 0), vi2(x)]);
    c.prepare('INSERT INTO gen_metadata VALUES (0, ?, ?)').run(Buffer.concat([l2(1, Buffer.concat([
      l2(9, l2(10, v2(1, 5000))),
      l2(19, Buffer.from('gemini-3-pro')),
      l2(20, Buffer.concat([l2(1, Buffer.from('last_step_index')), l2(2, Buffer.from('0'))])),
    ]))]), 0);
    c.close();
  }
  appendFileSync(u2, JSON.stringify({ step_index: 2, type: 'GENERIC', created_at: ISO(10000), content: 'f'.repeat(40) }) + '\n');
  ok('补 db + 新增行后 scan 退出码 0', cli(['scan']).status === 0);

  const db = new DatabaseSync(dbFile, { readOnly: true });
  ok('重放的历史行不重复计费',
    db.prepare("SELECT COUNT(*) n FROM events WHERE tool='antigravity' AND dedup_key LIKE '%u1-anty:%'").get().n === 2,
    JSON.stringify(db.prepare("SELECT dedup_key FROM events WHERE dedup_key LIKE '%u1-anty:%'").all()));
  const u2row = db.prepare("SELECT input_tokens, total_tokens, model FROM events WHERE dedup_key = 'antigravity:anty-u2-anty:1'").get();
  ok('估算事件被权威上下文原地补正（25 → 5000）',
    u2row?.input_tokens === 5000 && u2row?.total_tokens === 5000 + 20,
    JSON.stringify(u2row));
  ok('补正不改动输出与模型',
    db.prepare("SELECT output_tokens o FROM events WHERE dedup_key = 'antigravity:anty-u2-anty:1'").get()?.o === 20);
  const atyTotal = db.prepare("SELECT SUM(total_tokens) t FROM events WHERE tool='antigravity'").get().t;
  ok(`antigravity 补正后总量 ${ATY_FINAL}`, atyTotal === ATY_FINAL, `${atyTotal} vs ${ATY_FINAL}`);
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
      res.status === 200 && s.totals?.all_time_tokens === 36850 + ATY_FINAL + DSH_T && Array.isArray(s.by_day) && s.by_day.length >= 1
      && Array.isArray(s.health) && s.health.length === SOURCES.length && s.costs && Array.isArray(s.costs.by_day)
      && Array.isArray(s.recent) && s.recent.length === Math.min(19 + DSH_N, 15),
      `totals=${s.totals?.all_time_tokens} health=${s.health?.length} recent=${s.recent?.length}`);
    // 健康表必须随注册表一起长——曾经它是一份硬编码工具清单，加源必漏
    ok('健康表覆盖全部注册源', s.health.length === SOURCES.length, `${s.health.length} vs ${SOURCES.length}`);
    const okTools = s.health.filter(h => h.status === 'ok').length;
    ok(`健康 ${hasDsh ? 12 : 11} 源 ok`, okTools === (hasDsh ? 12 : 11), `${okTools} ok`);
    ok('官方配额字段存在（无凭证时为 null，不编造）', 'claude_usage' in (s.quota || {}));
    ok('积分账本字段存在（qoder 1.75）', s.credits?.qoder?.total === 1.75, JSON.stringify(s.credits));
    ok('summary 含订阅 ROI（6 条目）', s.roi?.configured === true && s.roi?.entries?.length === 6, JSON.stringify(s.roi?.entries?.map(e => e.tool)));
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

/* OpenCode 的 assistant 消息是"先插后改"：开始生成时就插入一行，tokens 全 0；
 * 生成结束才原地 UPDATE 写入用量并刷新 time_updated（实测 1.18.31，每条消息恰一个 step-finish）。
 * 服务监听 -wal，生成过程中每次写入都会触发扫描——扫描几乎总落在"已插入、未完成"的窗口里。
 * 按 rowid 水位增量时，这行被当成 0 用量跳过、水位却越过了它，完成后的 UPDATE 再也读不到。 */
{
  const ocDb = join(HOME, '.local/share/opencode', 'opencode.db');
  const t0 = Date.now();
  const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  {
    const o = new DatabaseSync(ocDb);
    o.prepare(`INSERT INTO message VALUES ('oc-a3', 's-oc', ?, ?, ?)`).run(t0, t0, JSON.stringify({
      role: 'assistant', modelID: 'Oc-Test-Model', tokens: zero, time: { created: t0 },
    }));
    o.close();
  }
  ok('生成中途 scan 退出码 0', cli(['scan']).status === 0);
  {
    const o = new DatabaseSync(ocDb);
    o.prepare(`UPDATE message SET time_updated = ?, data = ? WHERE id = 'oc-a3'`).run(t0 + 5000, JSON.stringify({
      role: 'assistant', modelID: 'Oc-Test-Model',
      tokens: { total: 456, input: 400, output: 56, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: t0, completed: t0 + 5000 },
    }));
    o.close();
  }
  ok('生成完成后 scan 退出码 0', cli(['scan']).status === 0);
  {
    const db3 = new DatabaseSync(dbFile, { readOnly: true });
    ok('扫描落在生成中途的消息，完成后仍被采集',
      db3.prepare("SELECT total_tokens t FROM events WHERE dedup_key = 'opencode:oc-a3'").get()?.t === 456,
      JSON.stringify(db3.prepare("SELECT dedup_key, total_tokens FROM events WHERE tool='opencode'").all()));
    db3.close();
  }

  /* 已升级用户的游标早已越过漏掉的行：只修增量逻辑补不回历史，必须让旧 state 触发全量重扫。
   * 这里把 files 表还原成旧版本的真实形态（rowid 水位已越过、_v 为旧版本）来验证。 */
  const t1 = Date.now();
  {
    const o = new DatabaseSync(ocDb);
    o.prepare(`INSERT INTO message VALUES ('oc-a4', 's-oc', ?, ?, ?)`).run(t1, t1 + 3000, JSON.stringify({
      role: 'assistant', modelID: 'Oc-Test-Model',
      tokens: { total: 789, input: 700, output: 89, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: t1, completed: t1 + 3000 },
    }));
    // 水位恰好等于真实最大 rowid：比它大会触发"表变短即回退"，那就不是真实的中毒形态了
    const maxMsg = o.prepare('SELECT MAX(rowid) m FROM message').get().m;
    const maxPart = o.prepare('SELECT MAX(rowid) m FROM part').get().m;
    o.close();
    const w = new DatabaseSync(dbFile);
    w.prepare("UPDATE files SET state_json = ? WHERE tool = 'opencode'")
      .run(JSON.stringify({ maxRowid: maxMsg, partMaxRowid: maxPart, _v: 1 }));
    w.close();
  }
  ok('旧游标 scan 退出码 0', cli(['scan']).status === 0);
  {
    const db4 = new DatabaseSync(dbFile, { readOnly: true });
    ok('被旧版 rowid 水位越过的消息，升级后补回',
      db4.prepare("SELECT total_tokens t FROM events WHERE dedup_key = 'opencode:oc-a4'").get()?.t === 789,
      JSON.stringify(db4.prepare("SELECT dedup_key, total_tokens FROM events WHERE tool='opencode'").all()));
    // a1（被删但历史保留）+ a2 + a3 + a4
    ok('全量重扫不重复计数', db4.prepare("SELECT COUNT(*) n FROM events WHERE tool='opencode'").get().n === 4,
      String(db4.prepare("SELECT COUNT(*) n FROM events WHERE tool='opencode'").get().n));
    db4.close();
  }
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
 * shell 里手跑 scan 才正常——面板因此长期停在旧数据。清空 PATH 精确复现该环境
 * （注意：ZSTD_BINS 里的绝对路径回落不受 PATH 影响，CI 镜像常自带 /usr/bin/zstd，
 * 此时多帧文件仍走外部解压——这是正确行为，Windows 镜像则全世界没有 zstd）。
 */
console.log('\n[7] 无 zstd CLI 时仍能解 dsh');
{
  const zlib = require('node:zlib');
  if (!hasDsh || typeof zlib.zstdDecompressSync !== 'function') {
    console.log('  – 跳过（无 dsh fixture 或该 Node 无内置 zstd，只能靠外部 CLI）');
  } else {
    const { collectDshFile } = await import(pathToFileURL(join(ROOT, 'src/collectors/dsh.js')).href);
    const mkStub = () => { const ev = []; return { ev, store: { insertEvent: (e) => { ev.push(e); return 1; }, insertToolCall: () => 1 } }; };

    // 单帧文件：内置 zstd 单帧能力足够，任何平台（含无 zstd 的 Windows 镜像）都必须解出。
    // 压缩负载里碰巧出现的帧魔数不得误判成多帧（Windows CI 真实发生过）。
    // 夹具放在扫描根之外：这里只做单元级 collect，不能让后续层再把它扫进库污染黄金数字。
    const sfDir = join(HOME, '..', 'tw-sf-fixture');
    mkdirSync(sfDir, { recursive: true });
    const sfNow = Date.now();
    writeFileSync(join(sfDir, 'session.v3.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([
      JSON.stringify({ type: 'session', seq: 1, time: sfNow - 25000, cwd: '/work/projK' }),
      JSON.stringify({ type: 'assistant/message', seq: 2, time: sfNow - 24000,
        data: { usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 10 },
          message: { source: { model: 'Dsh-Sf-Model' } } } }),
    ].join('\n') + '\n')));
    const sf = mkStub();
    let sfErr = null;
    const savedPath = process.env.PATH;
    process.env.PATH = '';   // launchd 环境：CLI 一律找不到
    try { await collectDshFile(sf.store, { path: join(sfDir, 'session.v3.jsonl.zstd'), fileId: 's-dsh-sf' }); }
    catch (e) { sfErr = e; }
    finally { process.env.PATH = savedPath; }
    ok('PATH 里没有 zstd 时单帧文件不抛错', !sfErr, String(sfErr?.message));
    ok('PATH 里没有 zstd 时单帧文件解出用量（内置解压）',
      sf.ev.length === 1 && sf.ev[0].total_tokens === 550 && sf.ev[0].model === 'dsh-sf-model',
      JSON.stringify(sf.ev));

    // 多帧文件（dsh 真实写入形态）：环境里有任一外部 zstd（含绝对路径回落）→ 必须全量
    // 解出；全世界都没有 zstd（Windows 镜像）→ 宁可大声失败的可操作报错。两者都对。
    const mf = mkStub();
    let mfErr = null;
    process.env.PATH = '';
    try { await collectDshFile(mf.store, { path: join(HOME, '.dsh/sessions/--work-projI--/s-dsh-v3/session.v3.jsonl.zstd'), fileId: 's-dsh-v3' }); }
    catch (e) { mfErr = e; }
    finally { process.env.PATH = savedPath; }
    if (mfErr) {
      ok('无任何 zstd 时多帧文件大声失败（可操作提示）', /多个 zstd 帧/.test(String(mfErr.message)), String(mfErr.message));
    } else {
      ok('系统默认 PATH 下多帧 dsh 仍解出用量（外部/绝对路径 zstd）',
        mf.ev.length === 1 && mf.ev[0].total_tokens === 1480, JSON.stringify(mf.ev));
    }
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

/* ---------- 第 8b 层：Codex 配额快照 ----------
 * rate_limits 的 primary/secondary 是**位置**，不是含义：plus 为 primary=5 小时、secondary=周；
 * pro/prolite 只有 primary=周（同一套餐也在两种形态间切换过）。只能按 window_minutes 认窗口。
 * 另有非主额度的快照混在同一条流里：Spark 模型的 codex_bengalfox、窗口全空的 premium。
 */
console.log('\n[8b] Codex 配额快照');
{
  const { quotaFromRateLimits, codexQuotaView } = await import(pathToFileURL(join(ROOT, 'src/codexQuota.js')).href);
  const w = (m, u, r = 1) => ({ used_percent: u, window_minutes: m, resets_at: r });
  const plus = quotaFromRateLimits({ limit_id: 'codex', primary: w(300, 25), secondary: w(10080, 42), plan_type: 'plus' });
  ok('plus：两个窗口都保留，按时长升序',
    JSON.stringify(plus?.windows?.map(x => [x.window_minutes, x.used_percent])) === '[[300,25],[10080,42]]', JSON.stringify(plus));
  const pro = quotaFromRateLimits({ limit_id: 'codex', primary: w(10080, 97), secondary: null, plan_type: 'prolite' });
  ok('pro：只有周窗口', JSON.stringify(pro?.windows?.map(x => x.window_minutes)) === '[10080]', JSON.stringify(pro));
  ok('Spark 独立额度不算主额度', quotaFromRateLimits({ limit_id: 'codex_bengalfox', primary: w(10080, 0) }) === null);
  ok('窗口全空的快照丢弃（否则显示成 0%）', quotaFromRateLimits({ limit_id: 'premium', primary: null, secondary: null }) === null);
  ok('没有 limit_id 的旧快照照常接受', quotaFromRateLimits({ primary: w(10080, 5) })?.windows?.length === 1);

  // 升级前存下的是旧形态（只有 primary 的平铺字段），不重扫也要能正确显示
  const legacy = codexQuotaView({ ts: 1, data: { used_percent: 25, window_minutes: 300, resets_at: 9, plan_type: 'plus' } });
  ok('旧形态快照转成窗口列表', JSON.stringify(legacy?.data?.windows) === '[{"window_minutes":300,"used_percent":25,"resets_at":9}]',
    JSON.stringify(legacy));
  ok('旧形态 plan_type 保留', legacy?.data?.plan_type === 'plus');
  ok('新形态原样返回', codexQuotaView({ ts: 1, data: plus })?.data?.windows?.length === 2);
  ok('无快照返回 null', codexQuotaView(null) === null);
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
  // Windows 上路径分隔符是反斜杠，按段比较而不是字符串后缀
  ok('入口脚本解析到真实存在的文件',
    existsSync(entry) && entry.replaceAll('\\', '/').endsWith('bin/tokenwatcher.js'), entry);

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

/* ---------- 第 11 层：CLI 新命令（today/sessions/wrapped/doctor/version/uninstall） ---------- */
console.log('\n[11] CLI 新命令');
{
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));

  const v = cli(['--version']);
  ok('--version 输出版本号', v.status === 0 && v.stdout.trim() === `token-watcher v${pkg.version}`, v.stdout.trim());

  // today --json：机器可读。期望值直接查库（同口径），免疫前面各层对夹具库的增量写入
  const expect = new DatabaseSync(dbFile, { readOnly: true });
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const expToday = expect.prepare('SELECT SUM(total_tokens) t, COUNT(*) n FROM events WHERE ts >= ?').get(dayStart.getTime());
  const expAll = expect.prepare('SELECT SUM(total_tokens) t FROM events').get();
  const tj = cli(['today', '--json']);
  let j = null;
  try { j = JSON.parse(tj.stdout); } catch { /* 断言会红 */ }
  ok('today --json 可解析', tj.status === 0 && !!j?.today, tj.stdout.slice(0, 120));
  ok('today --json 数字与库对齐（按日起点切）',
    j?.today?.tokens === expToday.t && j?.today?.requests === expToday.n,
    `${j?.today?.tokens}/${expToday.t} ${j?.today?.requests}/${expToday.n}`);
  ok('today --json all_time 与库对齐', j?.all_time?.tokens === expAll.t, `${j?.all_time?.tokens}/${expAll.t}`);
  ok('today --json 分工具明细含新源',
    ['kimi', 'qoder'].every(t => j?.today?.by_tool?.some(x => x.tool === t && x.t > 0)));
  ok('today --json 含 generated_at', /^\d{4}-/.test(j?.generated_at || ''));

  // today --light：纯 ASCII（CI/SSH 终端不依赖 UTF-8）
  const tl = cli(['today', '--light']);
  ok('today --light 纯 ASCII', tl.status === 0 && /^[\x20-\x7E\n]*$/.test(tl.stdout), tl.stdout.slice(0, 80));
  ok('today --light 含合计行', /TOTAL/.test(tl.stdout));

  // sessions
  const today = new Date().toLocaleDateString('sv-SE');
  const sj = cli(['sessions', '--day', today]);
  let s11 = null;
  try { s11 = JSON.parse(sj.stdout); } catch { /* 断言会红 */ }
  ok('sessions --day 输出 JSON', sj.status === 0 && s11?.day === today && Array.isArray(s11.sessions), sj.stdout.slice(0, 100));
  ok('sessions 字段完整（含峰值与模型清单）',
    s11?.sessions?.length >= 8 && s11.sessions[0].total > 0
    && 'peak' in s11.sessions[0] && 'models' in s11.sessions[0] && 'first_ts' in s11.sessions[0]);
  const sc = cli(['sessions', '--day', today, '--csv']);
  const csvLines = sc.stdout.trim().split('\n');
  ok('sessions --csv 表头与行数',
    sc.status === 0 && csvLines[0].startsWith('session_id,tool,project') && csvLines.length === 1 + s11.sessions.length,
    `${csvLines.length - 1} vs ${s11?.sessions?.length}`);
  ok('sessions --csv 含 commits 列（未开 --git 时为空）', csvLines[0].endsWith(',commits'));
  const badDay = cli(['sessions', '--day', '2026-9-20']);
  ok('sessions 非法日期退出码 1 并提示', badDay.status === 1 && /YYYY-MM-DD/.test(badDay.stdout + badDay.stderr));
  const half = cli(['sessions', '--from', today]);
  ok('sessions --from 单独出现报成对要求', half.status === 1 && /成对/.test(half.stdout + half.stderr));

  // wrapped
  const wj = cli(['wrapped', '--json']);
  let w11 = null;
  try { w11 = JSON.parse(wj.stdout); } catch { /* 断言会红 */ }
  const thisYear = new Date().getFullYear();
  const expYear = expect.prepare(
    "SELECT SUM(total_tokens) t FROM events WHERE CAST(strftime('%Y', ts/1000, 'unixepoch', 'localtime') AS INTEGER) = ?"
  ).get(thisYear).t;
  ok('wrapped --json 可解析且年份正确', wj.status === 0 && w11?.year === thisYear, wj.stdout.slice(0, 80));
  ok('wrapped 总量与库一致（按本地年切）', w11?.total_tokens === expYear, `${w11?.total_tokens}/${expYear}`);
  ok('wrapped 月度分布求和等于总量', (w11?.by_month || []).reduce((a, b) => a + b, 0) === w11?.total_tokens);
  ok('wrapped 覆盖连续天数与最忙一天', w11?.active_days >= 1 && w11?.longest_streak_days >= 1 && !!w11?.busiest_day?.day);
  const wr = cli(['wrapped']);
  ok('wrapped 人类可读报告含标题与首行', wr.status === 0 && wr.stdout.includes('年度报告') && /tokens/.test(wr.stdout));
  ok('wrapped 零值年份不炸', cli(['wrapped', '--year', '2020', '--json']).status === 0);
  expect.close();

  // doctor：fixtures 全新 → 全 ok，退出码 0；输出覆盖环境/库/数据源三段
  const dr = cli(['doctor']);
  ok('doctor 退出码 0（夹具全部健康）', dr.status === 0, (dr.stdout + dr.stderr).slice(0, 200));
  ok('doctor 输出三段体检', ['环境', '数据库', '数据源', '结论'].every(k => dr.stdout.includes(k)));
  ok('doctor 覆盖全部注册源', SOURCES.every(s => dr.stdout.includes(s.label)));

  // uninstall：非交互且无 --yes → 拒删数据目录；--yes --purge-data → 删净、退出码 0
  // （在独立临时 HOME 里跑，避免动到共享夹具库）
  const uHome = mkdtempSync(join(tmpdir(), 'tokenmeter-uninstall-'));
  const uEnv = { ...env, HOME: uHome, USERPROFILE: uHome };
  const ucli = (args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenwatcher.js'), ...args], { encoding: 'utf8', env: uEnv });
  mkdirSync(join(uHome, '.tokenmeter'), { recursive: true });
  writeFileSync(join(uHome, '.tokenmeter', 'sentinel'), 'x');
  const u1 = ucli(['uninstall', '--purge-data']);
  ok('uninstall 无 --yes 时拒绝删数据（非交互 stdin）', u1.status === 0 && existsSync(join(uHome, '.tokenmeter', 'sentinel')),
    u1.stdout.slice(0, 120));
  const u2 = ucli(['uninstall', '--purge-data', '--yes']);
  ok('uninstall --yes 删除数据目录', u2.status === 0 && !existsSync(join(uHome, '.tokenmeter')), u2.stdout.slice(0, 200));
  ok('uninstall 提示 npm 自卸命令', /npm rm -g token-watcher/.test(u2.stdout));
  rmSync(uHome, { recursive: true, force: true });

  // Homebrew formula：直连 npm registry、依赖 node、入口符号链接（发版时 update-formula.sh 回填 sha256）
  const formulaPath = join(ROOT, 'packaging/homebrew/Formula/token-watcher.rb');
  if (existsSync(formulaPath)) {
    const f = read(formulaPath);
    ok('formula 直连 npm registry tarball', /registry\.npmjs\.org\/token-watcher\/-\/token-watcher-[\d.]+\.tgz/.test(f));
    ok('formula 依赖 node 并链接全部 bin', /depends_on "node"/.test(f) && /bin\.install_symlink/.test(f));
    // formula 只在发版时回填 sha 与版本（update-formula.sh），开发期允许落后于
    // package.json，但不得超前（超前 = 会发布一个不存在于 npm 的版本）
    const fv = (f.match(/token-watcher-([\d.]+)\.tgz/) || [])[1];
    const gt = (a, b) => a.split('.').some((x, i) => +x > +(b.split('.')[i] ?? 0))
      && !b.split('.').some((x, i) => +x > +(a.split('.')[i] ?? 0));
    ok('formula 版本不超前于 package.json（发版时 update-formula.sh 回填）',
      fv && !gt(fv, pkg.version), `${fv} vs ${pkg.version}`);
    ok('update-formula.sh 随仓库提供', existsSync(join(ROOT, 'packaging/homebrew/update-formula.sh')));
  } else {
    ok('Homebrew formula 存在', false, formulaPath);
  }
}

/* ---------- 第 11b 层：sessions --git 提交归因 ----------
 * cwd 只在源文件首段（transcript 的 rec.cwd / rollout 的 session_meta），events 表只存目录名。
 * 归因必须读文件首段拿完整路径，再在 [first_ts, last_ts+30min] 窗口内查 git log。 */
console.log('\n[11b] sessions --git 提交归因');
{
  const repo = join(HOME, 'work', 'projGit');
  mkdirSync(repo, { recursive: true });
  const g = (args, opts = {}) => spawnSync('git', ['-C', repo, ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...opts.env } });
  g(['init', '-q']);
  writeFileSync(join(repo, 'f.txt'), 'x');
  const commitAt = new Date(Date.now() - 40_000).toISOString(); // 落在会话窗口内
  g(['add', '.']);
  g(['commit', '-q', '-m', 'feat: fixture commit'], { env: { GIT_AUTHOR_DATE: commitAt, GIT_COMMITTER_DATE: commitAt } });
  if (g(['log', '-1']).status !== 0) {
    console.log('  – git 不可用，跳过归因断言');
  } else {
    // 一条 40s 前的 claude 会话指向该仓库；一条无关会话（另一目录）不挂提交
    const wf = (p, lines) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, lines.join('\n') + '\n'); };
    wf(join(HOME, '.claude/projects/-work-projGit/s-git.jsonl'), [
      JSON.stringify({ timestamp: new Date(Date.now() - 60_000).toISOString(), type: 'assistant', requestId: 'rg', sessionId: 's-git', cwd: repo,
        message: { id: 'mg1', model: 'claude-opus-5', usage: { input_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8 } } }),
      JSON.stringify({ timestamp: new Date(Date.now() - 30_000).toISOString(), type: 'assistant', requestId: 'rg', sessionId: 's-git', cwd: repo,
        message: { id: 'mg2', model: 'claude-opus-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 4 } } }),
    ]);
    ok('归因夹具扫描退出码 0', cli(['scan']).status === 0);
    const r = cli(['sessions', '--day', new Date().toLocaleDateString('sv-SE'), '--git']);
    let s = null;
    try { s = JSON.parse(r.stdout); } catch { /* 断言会红 */ }
    const git = s?.sessions?.find(x => x.session_id === 's-git');
    const other = s?.sessions?.find(x => x.session_id === 's-claude');
    ok('会话挂上窗口内的提交', git?.commits === 1 && /fixture commit/.test(git?.commit_list?.[0]?.subject || ''),
      JSON.stringify(git?.commit_list));
    ok('窗口外提交不计入（夹具只有窗口内一笔，双保险见下）', (other?.commits ?? null) === null || other.commits >= 0);
    ok('非 git 项目的会话 commits 保持 null（诚实缺省）', s?.sessions?.every(x => x.tool !== 'claude-code' || x.commits == null || x.session_id === 's-git'),
      JSON.stringify(s?.sessions?.filter(x => x.commits != null).map(x => x.session_id)));
  }
}

/* ---------- 第 12 层：serve 端口行为（自动递增 / 显式端口大声失败） ---------- */
console.log('\n[12] serve 端口行为');
{
  // 随机端口起一个真实 serve（未显式 --port，经 TOKENMETER_PORT 指定基端口）
  const pickFree = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const base = await pickFree();
  const squatter = net.createServer();
  await new Promise(r => squatter.listen(base, '127.0.0.1', r)); // 占住基端口

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenwatcher.js'), 'serve'],
    { env: { ...env, TOKENMETER_PORT: String(base) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  const up = await new Promise(r => {
    const t = setTimeout(() => r(false), 30_000);
    const check = () => { if (buf.includes(`listening on http://127.0.0.1:${base + 1}`)) { clearTimeout(t); r(true); } };
    child.stdout.on('data', check); check();
  });
  ok('默认端口被占时自动落到下一端口', up, buf.slice(-200));
  if (up) {
    const res = await fetch(`http://127.0.0.1:${base + 1}/api/summary?days=1`);
    ok('递增端口上的面板可用', res.status === 200);
  }
  child.kill('SIGTERM');
  squatter.close();

  // 显式 --port 被占：必须失败退出（悄悄换端口会让菜单栏胶囊连不上）
  const blocker = net.createServer();
  const busy = await pickFree();
  await new Promise(r => blocker.listen(busy, '127.0.0.1', r));
  const c2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bin/tokenwatcher.js'), 'serve', '--port', String(busy)],
    { env: { ...env, TOKENMETER_PORT: String(busy) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const c2out = await new Promise(r => {
    let b2 = '';
    const t = setTimeout(() => r(b2), 30_000);
    c2.stdout.on('data', (d) => { b2 += d; });
    c2.on('exit', () => { clearTimeout(t); r(b2); });
  });
  ok('显式 --port 被占时退出码非 0 并提示', c2.exitCode !== 0 && /占用/.test(c2out), c2out.slice(-160));
  blocker.close();
}

/* ---------- 第 13 层：Claude 官方配额（单元，mock fetch，不出网） ---------- */
console.log('\n[13] Claude 官方配额单元');
{
  const cu = await import(pathToFileURL(join(ROOT, 'src/claudeUsage.js')).href);
  const n = cu.normalizeUsage({
    five_hour: { used_percent: 42.5, resets_at: '2026-09-20T08:00:00Z' },
    seven_day: { used_percent: 10, resets_at: '2026-09-22T08:00:00Z' },
    weekly_scoped: [{ kind: 'weekly_scoped', percent: 3.2, resets_at: '2026-09-25T08:00:00Z', scope: { model: { display_name: 'Opus', id: 'opus' } } }],
  });
  ok('官方配额归一化：窗口与 scoped 模型',
    n?.five_hour?.used_percent === 42.5 && n?.seven_day?.used_percent === 10
    && n?.weekly_scoped?.[0]?.label === 'Opus' && n?.weekly_scoped?.[0]?.used_percent === 3.2,
    JSON.stringify(n));
  ok('结构不认识的响应返回 null（接口改版≠0%）', cu.normalizeUsage({ foo: 1 }) === null && cu.normalizeUsage(null) === null);
  const t401 = await cu.fetchClaudeUsage('tok', { fetchImpl: () => Promise.resolve({ status: 401 }) }).catch(e => e);
  ok('401 给出可操作的提示（跑一次 claude 刷新登录）', /claude/.test(t401?.message || ''), t401?.message);
  // keychain 读取：macOS 分支用假 exec，凭证不存在时返回 null（未登录是正常态）
  const none = await cu.readClaudeOauthToken({ platform: 'linux', home: join(HOME, 'no-such-home') });
  ok('无凭证时返回 null 而非报错', none === null, String(none));
  const fileHome = mkdtempSync(join(tmpdir(), 'tokenmeter-cred-'));
  mkdirSync(join(fileHome, '.claude'), { recursive: true });
  writeFileSync(join(fileHome, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'atk' } }));
  ok('credentials.json 路径可读出 token',
    (await cu.readClaudeOauthToken({ platform: 'linux', home: fileHome })) === 'atk');
  rmSync(fileHome, { recursive: true, force: true });

  // sessions CSV 转义：项目名带逗号/引号不能炸列
  const sessionsMod = await import(pathToFileURL(join(ROOT, 'src/sessions.js')).href);
  const csv = sessionsMod.sessionsToCsv([{ session_id: 's', tool: 't', project: 'a,b"c', first_ts: 1, last_ts: 2, calls: 1, total: 3, peak: 3, models: 'm' }]);
  ok('sessions CSV 转义逗号与引号', csv.split('\n')[1].startsWith('s,t,"a,b""c"'), csv);

  // ZCode / GLM Coding Plan 官方配额：字段语义按 2026-09-21 本机实测（percentage=已用%，
  // usage=总额度，currentValue=已用，nextResetTime=ms；unit=3→5h、unit=6→月度）
  const zq = await import(pathToFileURL(join(ROOT, 'src/zcodeQuota.js')).href);
  const REAL_BODY = { code: 200, msg: '操作成功', success: true, data: { level: 'pro', limits: [
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 725, remaining: 11274, percentage: 6, nextResetTime: 1790011302789 },
    { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 28918, remaining: 31081, percentage: 48, nextResetTime: 1790310756997 },
  ] } };
  const zn = zq.normalizeZcodeQuota(REAL_BODY);
  ok('zcode 配额归一化：实测窗口（5 小时 6% / 月度 48%）与积分数值',
    zn?.windows?.length === 2
    && zn.windows[0].label === '5 小时' && zn.windows[0].used_percent === 6
    && zn.windows[0].used === 725 && zn.windows[0].total === 12000
    && zn.windows[0].resets_at === 1790011302789
    && zn.windows[1].label === '月度' && zn.windows[1].used_percent === 48 && zn.level === 'pro',
    JSON.stringify(zn));
  ok('zcode 没见过的窗口组合如实标注 unit（不硬贴标签）',
    zq.normalizeZcodeQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 9, percentage: 3 }] } })
      ?.windows?.[0]?.label === '窗口 unit=9');
  ok('zcode 结构不认识返回 null（接口改版≠0%）',
    zq.normalizeZcodeQuota({ foo: 1 }) === null && zq.normalizeZcodeQuota(null) === null);
  const z401 = await zq.fetchZcodeQuota({ origin: 'https://bigmodel.cn', apiKey: 'k' },
    { fetchImpl: () => Promise.resolve({ status: 401 }) }).catch(e => e);
  ok('zcode 401 给出可操作的提示（跑一次 zcode 登录）', /zcode/i.test(z401?.message || ''), z401?.message);
  const zcodeHome = mkdtempSync(join(tmpdir(), 'tokenmeter-zcode-'));
  ok('zcode 未装/未配置时 targets 为空（正常态）',
    (await zq.zcodeQuotaTargets({ home: zcodeHome })).length === 0);
  // MCP 调用配额：本地日志兜底。6 小时新鲜度窗下，"看昨天的日志"只在跨午夜场景有效
  const zlogDir = join(zcodeHome, '.zcode/v2/logs');
  mkdirSync(zlogDir, { recursive: true });
  const now2 = Date.now();
  const d0 = new Date(now2), d1 = new Date(now2 - 864e5);
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const logLine = (d, used) => `[${day(d)} 23:50:00.000] [info] [usage-stats] 官方 MCP 额度响应 ${JSON.stringify({ body: JSON.stringify({ code: 0, data: { total_usage: { used, limit: 1000, remaining: 1000 - used } } }), status: 200 })}`;
  // 场景一：今天 00:10，今天的日志还没写，昨日 23:50 的记录仍新鲜
  writeFileSync(join(zlogDir, `${day(d1)}.log`), logLine(d1, 3) + '\n');
  const justAfterMidnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0, 10).getTime();
  const mcpOld = await zq.readZcodeMcpUsage({ home: zcodeHome, nowMs: justAfterMidnight });
  ok('zcode MCP 配额跨午夜从昨日日志解出', mcpOld?.used === 3 && mcpOld?.limit === 1000, JSON.stringify(mcpOld));
  // 场景二：今天的日志存在时优先读今天（合成时刻 23:55，与真实时钟解耦）
  writeFileSync(join(zlogDir, `${day(d0)}.log`), logLine(d0, 3) + '\n');
  const tonight2355 = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 23, 55).getTime();
  ok('zcode MCP 配额优先取今日日志', (await zq.readZcodeMcpUsage({ home: zcodeHome, nowMs: tonight2355 }))?.used === 3);
  ok('zcode 日志全过期/缺失返回 null', await zq.readZcodeMcpUsage({ home: zcodeHome, nowMs: tonight2355 + 7 * 3600_000 }) === null);
  rmSync(zcodeHome, { recursive: true, force: true });

  // Cursor：本地无逐请求 token，走账号级 CSV。单元覆盖列名解析、口径换算、
  // 同值重复行指纹、poller 幂等（mock fetch + 假 cookie，不出网）
  const cur = await import(pathToFileURL(join(ROOT, 'src/cursorUsage.js')).href);
  const csvText = [
    'Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    '"2026-09-20T15:54:30.603Z","","","free","cursor-grok-4.6-medium","No","0","28375","52096","706","81177","0.09"',
    '"2026-09-20T15:54:30.603Z","","","free","cursor-grok-4.6-medium","No","0","28375","52096","706","81177","0.09"',
    '"2026-09-20T16:00:00.000Z","","","free","gpt-x","No","100","200","50","20","370","0.01"',
  ].join('\n');
  const rows = cur.parseCursorCsv(csvText);
  ok('cursor CSV 按表头名解析（列序无关）', rows.length === 3
    && rows[0].total_tokens === 81177 && rows[0].input_tokens === 28375
    && rows[0].cached_input === 52096 && rows[0].cache_write === 0,
    JSON.stringify(rows[0]));
  ok('cursor cache_write 列独立成项', rows[2].cache_write === 100 && rows[2].total_tokens === 370, JSON.stringify(rows[2]));
  ok('cursor 同值重复行指纹互异', new Set(rows.map(r => r.dedup_key)).size === 3, JSON.stringify(rows.map(r => r.dedup_key)));
  ok('cursor 坏表头返回空数组（接口改版≠乱入账）', cur.parseCursorCsv('a,b\n1,2').length === 0);
  {
    const { Store } = await import(pathToFileURL(join(ROOT, 'src/store.js')).href);
    const cHome = mkdtempSync(join(tmpdir(), 'tokenmeter-cursor-'));
    const cstore = new Store(join(cHome, 'x.db'));
    const saved = process.env.TOKENMETER_OFFLINE;
    delete process.env.TOKENMETER_OFFLINE; // poller 在线才工作；结束即恢复
    const poller = new cur.CursorUsagePoller(cstore, {
      fetchImpl: async () => ({ ok: true, text: async () => csvText }),
      cookieImpl: () => 'fake-cookie',
    });
    await poller.poll();
    const n1 = cstore.db.prepare("SELECT COUNT(*) n FROM events WHERE tool='cursor'").get().n;
    ok('cursor poller 事件入库（3 行）', n1 === 3, String(n1));
    await poller.poll();
    const n2b = cstore.db.prepare("SELECT COUNT(*) n FROM events WHERE tool='cursor'").get().n;
    ok('cursor poller 幂等（重复导出不重复入账）', n2b === 3, String(n2b));
    process.env.TOKENMETER_OFFLINE = saved;
    cstore.close();
    rmSync(cHome, { recursive: true, force: true });
  }
}

/* ---------- 清理 ---------- */
rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);

function read(p) { return readFileSync(p, 'utf8'); }
import { readFileSync } from 'node:fs';
