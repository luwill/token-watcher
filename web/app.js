/* Token Watcher 面板：fetch /api/summary 渲染，SSE 实时刷新。
 * 纯逻辑（格式化/系列选择/配色/悬浮框定位）在 lib/ 下，可被 test/run.mjs 直接 import。
 * ECharts 走全局 UMD（index.html 里的 <script>），不参与模块图。 */
import { esc, fmt, fmtShort, hhmm, ymd, windowLabel, fmtCountdown, prettyModel, displayModelName } from './lib/format.js';
import {
  TOOL_COLORS, TOOL_LABEL, MODEL_PALETTE, OTHER_COLOR, OTHER_DECAL, HEAT_COLORS, HEAT_EMPTY,
} from './lib/theme.js';
import { pickSeries, assignSlots, stackTipFormatter, dayAxis, fillDays } from './lib/series.js';
import { chartTooltip as makeTooltip } from './lib/tooltip.js';

let days = 7;
let topView = 'overview';
let heatMode = 'd';
let lastSummary = null;

const charts = {};
for (const [k, id] of [['trend', 'ch-trend'], ['model', 'ch-model'], ['tool', 'ch-tool'], ['heat', 'ch-heat'], ['toolsAct', 'ch-tools-act'], ['sess', 'sess-detail'], ['costday', 'ch-costday']]) {
  const el = document.getElementById(id);
  if (el) {
    // 堆叠矩形独立在 Canvas 上抗锯齿，会在共享的小数像素边界露出暗缝。
    // 两张按天图使用 SVG，由 crispEdges 将相邻边界栅格化到同一像素。
    const stacked = k === 'trend' || k === 'costday';
    if (stacked) el.classList.add('crisp-stack');
    charts[k] = echarts.init(el, null, { renderer: stacked ? 'svg' : 'canvas' });
  }
}
// 成对行布局会拉伸图表容器，ECharts 需显式 resize 才重排；
// 必须先比对尺寸再 resize，否则与 flex 布局形成反馈循环（容器无限拉长）
for (const c of Object.values(charts)) {
  const dom = c.getDom();
  let lastW = 0, lastH = 0;
  new ResizeObserver(() => {
    const r = dom.getBoundingClientRect();
    if (Math.abs(r.width - lastW) > 1 || Math.abs(r.height - lastH) > 1) {
      lastW = r.width; lastH = r.height;
      c.resize();
    }
  }).observe(dom);
}
window.addEventListener('resize', () => {
  Object.values(charts).forEach(c => c.resize());
  // 布局稳定后重算格子尺寸（视口动画期间 clientWidth 会有中间态）
  setTimeout(() => { if (lastSummary) renderHeatmap(lastSummary.by_day_all); }, 150);
});

/** 按 charts 里的实例名取容器，交给统一的悬浮框配置（定位与裁切处理在 lib/tooltip.js） */
const chartTooltip = (key, extra = {}) => makeTooltip(charts[key].getDom(), extra);

const MODEL_SLOT = new Map(); // 模型名 → 色槽，跨渲染保留，保证同名恒同色
const TOOL_SLOT = new Map();  // 同上，给不在 TOOL_COLORS 里的新工具兜底色

// ECharts 不会让图例避让 x 轴标签，底部留白得自己算：
// 旋转 45° 的日期标签更占高度，图例换行后按两行预留
const LEGEND_H = 46;
const gridBottom = (rowCount) => (rowCount > 31 ? 44 : 22) + LEGEND_H;

// 按天消耗与按天花费上下相邻，必须共用柱宽上限与绘图区边距，
// 否则两图类目数/绘图区宽不同时，柱子实际渲染宽度就对不上
const BAR_MAX_W = 24; // dataviz 规范：柱宽 ≤24px，不填满类目槽，留白给间隙
const DAY_GRID = { left: 70, right: 16, top: 14 };

/* ---------- 主题 / 空态 / 进度条助手 ---------- */
// 图表颜色在每次渲染时从 CSS 变量读：切换主题后整页重绘即可换色，ECharts 不必感知主题
const cssVar = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
const isLight = () => document.documentElement.dataset.theme === 'light';

// 浅色底的工具色：同色相加深到白底可读。色相未动，区分度排序继承深色版的 CIEDE2000 校验；
// 与 style.css 的 [data-theme="light"] .badge.* 同步维护。
const LIGHT_TOOL_COLORS = {
  'claude-code': '#b4533a', 'ccmr': '#6d5bd0', 'codex': '#0e8a55', 'zcode': '#8a6d15',
  'dsh': '#1c6fb8', 'workbuddy': '#c9386f', 'grok': '#333a44', 'pi': '#0c7f8f',
  'opencode': '#bc5a10', 'kimi': '#25743f', 'qoder': '#7d5236', 'cursor': '#7d6412', 'antigravity': '#4f4a5c',
};
const toolColor = (t, fallback) => (isLight() && LIGHT_TOOL_COLORS[t]) || TOOL_COLORS[t] || fallback;

// GitHub 浅色版热力阶（白底淡→深绿、空格浅灰）；深色版常量在 lib/theme.js
const HEAT_COLORS_LIGHT = ['#9be9a8', '#40c463', '#30a14e', '#216e39'];
const heatColors = () => (isLight() ? HEAT_COLORS_LIGHT : HEAT_COLORS);
const heatEmpty = () => (isLight() ? '#ebedf0' : HEAT_EMPTY);

/** 空态：清掉旧图并显示占位文案；数据回来时由 clearEmpty 恢复 */
function markEmpty(key) {
  const el = charts[key]?.getDom();
  if (!el) return;
  charts[key].clear();
  el.classList.add('empty');
  el.dataset.empty = '范围内无数据';
}
function clearEmpty(key) {
  const el = charts[key]?.getDom();
  if (el && el.classList.contains('empty')) { el.classList.remove('empty'); delete el.dataset.empty; }
}

/** 配额进度条：按阈值整体换色（lv-ok/lv-warn/lv-hot 见 style.css） */
const qBar = (used) => {
  const lv = used >= 90 ? 'lv-hot' : used >= 70 ? 'lv-warn' : 'lv-ok';
  return `<div class="q-bar"><div class="q-fill ${lv}" style="width:${Math.min(used, 100)}%"></div></div>`;
};

/* 主题持久化：默认深色，手动选择记入 localStorage；切换后整页重绘（图表色是渲染时读的） */
if (localStorage.getItem('tw-theme') === 'light') document.documentElement.dataset.theme = 'light';
document.getElementById('theme-btn').addEventListener('click', () => {
  const root = document.documentElement;
  const toLight = root.dataset.theme !== 'light';
  if (toLight) root.dataset.theme = 'light'; else root.removeAttribute('data-theme');
  localStorage.setItem('tw-theme', toLight ? 'light' : 'dark');
  if (lastSummary) render();
});

async function load() {
  const banner = document.getElementById('load-error');
  try {
    const res = await fetch(`/api/summary?days=${days}`);
    if (!res.ok) throw new Error(`服务返回 ${res.status}`);
    const data = await res.json();
    // 后端出错时返回的是 {error}，直接喂给 render() 会在 totals 上抛 TypeError
    if (!data?.totals) throw new Error(data?.error || '响应缺少 totals');
    lastSummary = data;
    if (banner) banner.hidden = true;
    render();
  } catch (err) {
    // 静默失败会让页面停在旧数字上却毫无迹象——宁可显眼地说明"这是上次的数据"
    if (!banner) return;
    banner.textContent = `数据刷新失败：${err.message}。当前显示的是上次成功获取的数据。`;
    banner.hidden = false;
  }
}

function render() {
  const s = lastSummary;
  const t = s.totals;
  const cards = [
    [fmt(t.all_time_tokens), '累计 Tokens'],
    [fmt(t.today_tokens), '今日消耗'],
    [fmt(t.last7d_tokens), '近 7 天消耗'],
    [fmt(t.peak_day_tokens), '峰值单日'],
    [t.today_active_sessions, '今日活跃会话'],
    [t.streak_days + ' 天', '连续使用'],
  ];
  document.getElementById('cards').innerHTML = cards
    .map(([v, l]) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  document.getElementById('gen').textContent = `更新于 ${new Date(s.generated_at).toLocaleString('zh-CN')}`;

  // 各组件独立容错：单个失败不连坐整页，错误记录便于排查
  window.__renderErr = [];
  const safe = (name, fn) => { try { fn(); } catch (e) { window.__renderErr.push(name + ': ' + e.message); } };
  safe('status', () => renderStatus(s.quota, s.balances, s.wb_rates, s.recon, s.costs, s.credits));
  safe('health', () => renderHealth(s.health));
  safe('live', () => renderLive(s.live));
  safe('balanceStatus', () => renderBalanceStatus(s.balance_status));
  safe('trend', () => renderTrend(s.by_day));
  safe('costday', () => renderCostDay(s.costs?.by_day));
  safe('density', () => renderDensity(s.by_day));
  safe('model', () => renderModel(s.by_model));
  safe('tool', () => renderTool(s.by_tool));
  safe('heat', () => renderHeatmap(s.by_day_all));
  safe('feed', () => renderFeed(s.recent));
  safe('toolsAct', () => renderToolActivity());
  safe('sessions', () => loadSessions());
}

function renderStatus(quota, balances, rates, recon, costs, credits) {
  const host = document.getElementById('quota-extra');
  const wide = document.getElementById('quota-wide');
  if (!host) return;
  // 两个网格按内容密度分流：紧凑卡（配额/余额/积分）与明细宽卡（花费/ROI/费率）。
  // 混在同一网格时行内高度差会全部变成矮卡底部的空白。
  let html = '';
  let whtml = '';

  // Codex 配额：plus 有 5 小时 + 周两个窗口，pro 只有周窗口——逐个窗口各画一条
  const q = quota?.codex;
  if (q?.data?.windows?.length) {
    const d = q.data;
    const rows = d.windows.map((w) => {
      const used = Number(w.used_percent) || 0;
      return `<div class="q-win">
        <div class="q-meta q-win-head"><span title="已用 ${used.toFixed(1)}%"><b>${esc(windowLabel(w.window_minutes))}</b> ${used.toFixed(1)}%</span>
          <span class="dim">重置 <b class="cd" data-at="${esc(w.resets_at)}">--</b></span></div>
        ${qBar(used)}
      </div>`;
    }).join('');
    html += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">Codex 配额</span>
        <span class="q-plan">${esc(d.plan_type)}</span></div>
      ${rows}
    </div>`;
  }

  // GLM Coding Plan 配额（积分口径，官方 monitor 端点）。与 Codex 配额卡同构：
  // 百分比 + 进度条 + 重置倒计时，积分数值放 tooltip；MCP 调用配额进 summary JSON 不占卡面
  const zq = quota?.zcode;
  if (zq && !zq.stale && zq.windows?.length) {
    const intFmt = (x) => Number(x).toLocaleString('zh-CN');
    const winRow = (w, unit) => {
      const used = Number(w.used_percent) || 0;
      const tip = Number.isFinite(w.used) && Number.isFinite(w.total)
        ? ` title="已用 ${used.toFixed(1)}% · ${intFmt(w.used)} / ${intFmt(w.total)} ${unit}"` : ' title="已用"';
      const reset = w.resets_at
        ? `<span class="dim">重置 <b class="cd" data-at="${Math.floor(w.resets_at / 1000)}">--</b></span>` : '';
      return `<div class="q-win">
        <div class="q-meta q-win-head"><span${tip}><b>${esc(w.label)}</b> ${used.toFixed(1)}%</span>${reset}</div>
        ${qBar(used)}
      </div>`;
    };
    const rows = zq.windows.map((w) => winRow(w, '积分')).join('');
    html += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">GLM Coding Plan</span>
        ${zq.level ? `<span class="q-plan">${esc(String(zq.level).toUpperCase())}</span>` : ''}</div>
      ${rows}
    </div>`;
  }

  // Claude 官方配额（OAuth 凭证可得时优先；无凭证回落到下方 5h 推算卡）
  const cu = quota?.claude_usage;
  if (cu && !cu.stale && (cu.five_hour || cu.seven_day || cu.weekly_scoped?.length)) {
    const winRow = (label, w) => {
      if (!w) return '';
      const used = Number(w.used_percent) || 0;
      // .cd 倒计时按 unix 秒解析 data-at；Claude 官方给的是 ISO 字符串，先归一到秒
      const atSec = w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) || '' : '';
      return `<div class="q-win">
        <div class="q-meta q-win-head"><span title="已用 ${used.toFixed(1)}%"><b>${esc(label)}</b> ${used.toFixed(1)}%</span>
          <span class="dim">重置 <b class="cd" data-at="${atSec}">--</b></span></div>
        ${qBar(used)}
      </div>`;
    };
    const scoped = (cu.weekly_scoped || []).map(s => winRow(`${s.label} 周额度`, s)).join('');
    // 官方卡最多 3+ 行（5h/每周/scoped），放紧凑网格会把整行撑高，归宽卡网格
    whtml += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">Claude 配额</span><span class="q-plan cc">官方</span></div>
      ${winRow('5 小时窗口', cu.five_hour)}
      ${winRow('每周窗口', cu.seven_day)}
      ${scoped}
    </div>`;
  } else {
    // Claude 5h 窗口（无官方数据时的推算兜底）
    const c5 = quota?.claude5h;
    if (c5 && c5.active) {
      html += `<div class="quota-card">
        <div class="quota-head"><span class="q-title">Claude 5h 窗口</span><span class="q-plan cc">推算</span>
          <span class="q-reset">${c5.window_calls} 次调用</span></div>
        <div class="q-meta" style="margin-top:2px">
          <span class="stat-value">${fmt(c5.window_tokens)}</span>
          <span class="dim">剩余 <b class="cd" data-at="${Math.floor(c5.window_ends_at / 1000)}">--</b></span>
        </div>
      </div>`;
    }
  }

  // 厂商余额（含对账）
  for (const b of balances || []) {
    const rc = (recon || []).find(r => r.id === b.id);
    let reconLine = '';
    if (rc && rc.delta != null && rc.spend != null) {
      const ok = Math.abs(rc.delta + rc.spend) < Math.max(1, rc.spend * 0.3) ? '✓' : '⚠';
      reconLine = `<div class="recon dim">${ok} ${rc.hours}h 余额 ${rc.delta.toFixed(2)} ¥ vs 统计 ${-rc.spend.toFixed(2)} ¥</div>`;
    }
    html += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">${esc(b.provider)} 余额</span>
        <span class="q-reset">${esc(b.currency)}</span></div>
      <div class="q-meta" style="margin-top:2px">
        <span class="stat-value">¥ ${Number(b.balance).toFixed(2)}</span>
        <span class="dim">${new Date(b.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span>
      </div>
      ${reconLine}
    </div>`;
  }

  // API 花费
  if (costs && (costs.today_cny > 0 || costs.all_cny > 0)) {
    const chips = esc((costs.by_tool || []).slice(0, 4)
      .map(t => `${TOOL_LABEL[t.tool] || t.tool} ¥${t.cost_cny.toFixed(2)}`).join(' · '));
    const unpriced = costs.unpriced?.length ? `<div class="recon dim" title="${esc(costs.unpriced.map(prettyModel).join(', '))}">⚠ ${costs.unpriced.length} 个模型未配价</div>` : '';
    whtml += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">API 花费（LiteLLM 牌价）</span>
        <span class="q-reset" title="${costs.fx_ts ? '汇率时间 ' + esc(new Date(costs.fx_ts).toLocaleString('zh-CN')) : ''}">USD×${esc(costs.usd_to_cny)}${costs.fx_source === 'manual' ? '' : ' ·实时'}</span></div>
      <div class="q-meta" style="margin-top:2px">
        <span class="stat-value">今日 ¥ ${costs.today_cny.toFixed(2)}</span>
        <span class="dim">近7天 ¥ ${costs.last7d_cny.toFixed(2)}</span>
      </div>
      <div class="recon dim" title="${chips}">${chips}</div>
      <div class="recon dim" style="margin-top:2px">ccmr 为实付 · 订阅工具为 API 等值成本</div>
      ${unpriced}
    </div>`;
  }

  // 积分制源的消耗（Qoder：本地不报 token，只报积分——如实按积分展示，不折算）
  if (credits?.qoder && (credits.qoder.today > 0 || credits.qoder.total > 0)) {
    html += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">Qoder 积分消耗</span>
        <span class="q-plan cc">官方口径</span></div>
      <div class="q-meta" style="margin-top:2px">
        <span class="stat-value">今日 ${credits.qoder.today.toFixed(2)}</span>
        <span class="dim">累计 ${credits.qoder.total.toFixed(1)} 积分</span>
      </div>
      <div class="recon dim">上游本地不报 token，仅积分；token 待其恢复上报</div>
    </div>`;
  }

  // 订阅 ROI：本月 API 等值 vs 实付（假设性口径，标注清楚）
  const roi = lastSummary?.roi;
  if (roi?.configured && roi.entries.length) {
    const rows = roi.entries.map(e => {
      const apiShort = e.credits != null && e.api_cny <= 0
        ? `积分 ${e.credits.toFixed(1)}`
        : `¥${e.api_cny < 0.01 ? e.api_cny.toFixed(4) : e.api_cny.toFixed(2)}`;
      const apiFull = e.credits != null && e.api_cny <= 0
        ? `积分 ${e.credits.toFixed(1)}`
        : `API 等值 ¥${e.api_cny < 0.01 ? e.api_cny.toFixed(4) : e.api_cny.toFixed(2)}`;
      const badge = e.paid_cny == null ? '<span class="dim">月费未填</span>'
        : e.ratio == null ? '<span class="dim">—</span>'
        : e.ratio >= 1 ? `<b style="color:var(--good)">×${e.ratio.toFixed(1)} 划算</b>`
        : `<b style="color:var(--warn)">×${e.ratio.toFixed(1)}</b>`;
      const paid = e.paid_cny == null ? '' : ` / ¥${e.paid_cny.toFixed(0)}`;
      return `<div class="q-meta" style="margin-top:4px" title="${esc(apiFull)}${e.paid_cny != null ? esc(' / 月费 ¥' + e.paid_cny.toFixed(0)) : ' · 月费未填'}">
        <span>${esc(e.name)}</span>
        <span class="dim">${apiShort}${paid}　${badge}</span>
      </div>`;
    }).join('');
    whtml += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">订阅 ROI（本月）</span>
        <span class="q-plan cc">假设性口径</span></div>
      ${rows}
      <div class="recon dim" style="margin-top:4px" title="API 等值 ≠ 订阅价值：订阅含速率限制，API 可能有折扣价">订阅限速、API 或有折扣价，非等价换算</div>
    </div>`;
  } else if (roi?.hint) {
    whtml += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">订阅 ROI</span><span class="q-reset">未配置</span></div>
      <div class="q-meta" style="margin-top:2px">
        <span>本月订阅工具 API 等值 ¥${roi.hint.sub_tools_api_cny.toFixed(2)}</span>
      </div>
      <div class="recon dim">配置 ~/.tokenmeter/subscriptions.json 的月费后显示 ROI（格式见 README）</div>
    </div>`;
  }

  // WorkBuddy 费率
  if (rates?.length) {
    const rows = rates.map(r => `<tr>
      <td>${esc(prettyModel(r.model))}</td><td class="num">${r.fresh_rate.toFixed(1)}</td>
      <td class="num dim">${r.cache_rate.toFixed(1)}</td><td class="num">${r.out_rate.toFixed(1)}</td><td class="num dim">${r.turns}</td>
    </tr>`).join('');
    const lastUp = Math.max(...rates.map(r => r.updated_at || 0));
    const updLine = lastUp > 0
      ? `<div class="recon dim">traceId 余额对账自学习 · 最近更新 ${new Date(lastUp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>` : '';
    whtml += `<div class="quota-card rates-card">
      <div class="quota-head"><span class="q-title">WorkBuddy 积分费率（自学习）</span>
        <span class="q-reset">积分/百万 token</span></div>
      <table class="rates-table"><thead><tr><th>模型</th><th class="num">输入</th><th class="num">缓存</th><th class="num">输出</th><th class="num">样本</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${updLine}
    </div>`;
  }
  host.innerHTML = html;
  if (wide) wide.innerHTML = whtml;
}

/** 图例（plain 换行）会从底边向上生长：行数多时上面的行会叠进绘图区压在柱子上，
 * 色块（14×9）浮在柱段上看起来就是"堆叠段没对齐"。按系列名估宽算行数，
 * 让 grid.bottom 给换行图例留出空间。 */
function legendExtraBottom(names, chartW) {
  const textW = (s) => [...String(s)].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e00 ? 11 : 6.2), 0);
  const total = names.reduce((s, n) => s + 14 + 5 + textW(n) + 10, 0); // 色块+间距+文字+itemGap
  const rows = Math.max(1, Math.ceil(total / Math.max(1, chartW)));
  return rows > 1 ? (rows - 1) * 17 + 6 : 0;
}

/** 按天花费（模型堆叠柱形图） */
function renderCostDay(byDay) {
  if (!charts.costday) return;
  if (!byDay?.length) return markEmpty('costday');
  clearEmpty('costday');
  // DeepSeek 家模型统一归并为 deepseek-v4.1-flash 展示（按用户口径）；
  // 其余 id 只做展示名点化（claude-opus-5-5 → claude-opus-5.5），键不换（displayModelName）
  const byDayMap = new Map(byDay.map(d => [d.day, d]));
  // 与按天消耗共用同一条日期轴（同样补洞），否则类目数不同、柱子无法对齐等宽
  const rows = dayAxis(byDay, days || 90).map((day) => {
    const models = {};
    for (const [m, c] of Object.entries(byDayMap.get(day)?.models || {})) {
      const n = displayModelName(m);
      models[n] = (models[n] || 0) + c;
    }
    return { day, models };
  });
  const { keys, rest } = pickSeries(rows, r => r.models, MODEL_PALETTE.length);
  const slots = assignSlots(keys, MODEL_PALETTE.length, MODEL_SLOT);
  const otherName = rest.length ? `其他(${rest.length})` : '';
  const sumOf = (names, day) => names.reduce((s, n) => s + (day[n] || 0), 0);
  const barOf = (name, names, itemStyle) => ({
    name, type: 'bar', stack: 'c', barMaxWidth: BAR_MAX_W, itemStyle,
    data: rows.map(r => { const v = sumOf(names, r.models); return v > 0 ? +v.toFixed(4) : 0; }),
  });
  const series = keys.map(n => barOf(n, [n], { color: MODEL_PALETTE[slots.get(n)] }));
  if (rest.length) series.push(barOf(otherName, rest, { color: OTHER_COLOR, decal: OTHER_DECAL }));
  charts.costday.setOption({
    animation: false,
    grid: { ...DAY_GRID, bottom: gridBottom(rows.length) + legendExtraBottom(series.map(s => s.name), charts.costday.getWidth()) },
    tooltip: chartTooltip('costday', {
      trigger: 'axis',
      formatter: stackTipFormatter(
        (v) => `¥${v.toFixed(2)}`, i => rows[i]?.models || {}, rest, otherName, 0.005),
    }),
    // plain（默认）会换行铺开，保证每条系列都能直接看到，不用翻页
    legend: { textStyle: { color: cssVar('--dim'), fontSize: 11 }, bottom: 0, itemWidth: 14, itemHeight: 9, itemGap: 10 },
    xAxis: {
      type: 'category', data: rows.map(d => d.day.slice(5)),
      axisLabel: { color: cssVar('--dim'), rotate: rows.length > 31 ? 45 : 0, fontSize: 11 },
      axisLine: { lineStyle: { color: cssVar('--border') } },
    },
    yAxis: { type: 'value', axisLabel: { color: cssVar('--dim'), formatter: (v) => '¥' + v }, splitLine: { lineStyle: { color: cssVar('--gridline') } } },
    series,
  }, true);
}

/** 厂商余额卡（含对账行）+ 成本卡 + WorkBuddy 自学习费率卡（动态注入 quota 网格） */
/** 进行中会话指示（如 Grok 轮次未结束时的实时上下文水位） */
function renderLive(live) {
  const host = document.getElementById('health');
  if (!host || !live?.grok) return;
  const el = document.createElement('span');
  el.className = 'h-chip live-chip';
  el.innerHTML = `<i style="background:${isLight() ? '#333a44' : '#e6edf3'}"></i>Grok 进行中<b>上下文 ${fmtShort(live.grok.context_tokens)}</b>`;
  el.title = `${live.grok.project ?? ''} · 用量将在轮次结束时落盘`;
  host.appendChild(el);
}

/** 被熔断的余额源：静默停用比一直刷错误更难排查，明确标出来并给出原因 */
function renderBalanceStatus(list) {
  const host = document.getElementById('health');
  if (!host || !list?.length) return;
  for (const s of list) {
    const el = document.createElement('span');
    el.className = 'h-chip';
    el.innerHTML = `<i style="background:var(--warn)"></i>${esc(s.id)} 余额<em class="warn"> 已停用</em>`;
    el.title = s.reason || '';
    host.appendChild(el);
  }
}

/** 数据源健康条 */
function renderHealth(health) {
  const host = document.getElementById('health');
  if (!host || !health?.length) return;
  const ago = (ts) => {
    if (!ts) return '无';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 60) return `${m}分`;
    if (m < 1440) return `${Math.floor(m / 60)}时`;
    return `${Math.floor(m / 1440)}天`;
  };
  const dot = { ok: 'var(--good-dot)', empty: '#55556a', stale: 'var(--warn)', error: 'var(--bad)' };
  const label = { ok: '', empty: ' 无数据', stale: ' 疑似停更', error: ' 解析错误' };
  host.innerHTML = health.map(h =>
    `<span class="h-chip" title="${esc(h.last_error || (h.last_event_ts ? '最近事件 ' + new Date(h.last_event_ts).toLocaleString('zh-CN') : ''))}">
      <i style="background:${dot[h.status] || '#55556a'}"></i>${esc(TOOL_LABEL[h.tool] || h.tool)}
      <b>${ago(h.last_event_ts)}</b><em class="${h.status === 'ok' ? '' : 'warn'}">${label[h.status] || ''}</em>
    </span>`).join('');
}

setInterval(() => {
  for (const node of document.querySelectorAll('.cd[data-at]')) {
    const at = Number(node.dataset.at);
    node.textContent = at ? fmtCountdown(at * 1000 - Date.now()) : '--';
  }
}, 1000);


function renderTrend(byDay) {
  if (!byDay?.length) return markEmpty('trend');
  clearEmpty('trend');
  const rows = fillDays(byDay, days || 90);
  // 只画范围内真正用过的工具，最近用过的排前面（今天没用、范围内用过的仍保留，
  // 否则那天的柱子没有图例可解释）；工具数超出品牌色数量时归入「其他」
  const { keys, rest } = pickSeries(rows, r => r.tools, Object.keys(TOOL_COLORS).length);
  const slots = assignSlots(keys.filter(t => !TOOL_COLORS[t]), MODEL_PALETTE.length, TOOL_SLOT);
  const colorOf = (t) => toolColor(t, MODEL_PALETTE[slots.get(t)]);
  const labelOf = (t) => TOOL_LABEL[t] || t;
  const otherName = rest.length ? `其他(${rest.length})` : '';
  const sumOf = (names, day) => names.reduce((s, n) => s + (day[n] || 0), 0);
  const barOf = (name, names, itemStyle) => ({
    name, type: 'bar', stack: 'x', barMaxWidth: BAR_MAX_W, itemStyle,
    data: rows.map(r => sumOf(names, r.tools) || 0),
  });
  const series = keys.map(t => barOf(labelOf(t), [t], { color: colorOf(t) }));
  if (rest.length) series.push(barOf(otherName, rest, { color: OTHER_COLOR, decal: OTHER_DECAL }));
  // 柱段统一直角：带圆弧的 SVG 路径仍可能抗锯齿，在底边重新引入接缝。
  charts.trend.setOption({
    animation: false,
    grid: { ...DAY_GRID, bottom: gridBottom(rows.length) + legendExtraBottom(series.map(s => s.name), charts.trend.getWidth()) },
    tooltip: chartTooltip('trend', {
      trigger: 'axis',
      formatter: stackTipFormatter(fmt, i => rows[i]?.tools || {}, rest, otherName),
    }),
    // plain（默认）换行铺开，工具变多或窄屏时不把条目藏进翻页
    legend: { textStyle: { color: cssVar('--dim'), fontSize: 11 }, bottom: 0, itemWidth: 14, itemHeight: 9, itemGap: 10 },
    xAxis: {
      type: 'category', data: rows.map(r => r.day.slice(5)),
      axisLabel: { color: cssVar('--dim'), rotate: rows.length > 31 ? 45 : 0, fontSize: 11 },
      axisLine: { lineStyle: { color: cssVar('--border') } },
    },
    yAxis: {
      type: 'value', axisLabel: { color: cssVar('--dim'), formatter: fmtShort },
      splitLine: { lineStyle: { color: cssVar('--gridline') } },
    },
    series,
  }, true);
}

// 点击趋势图某天 → 会话钻取
charts.trend.on('click', (params) => {
  if (params.componentType !== 'series') return;
  const day = (lastSummary?.by_day || []).find(r => r.day.slice(5) === params.name)?.day;
  if (day) {
    loadSessions(day);
    document.getElementById('sessions-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

/** 工具活动（Claude/ccmr tool_use + ZCode tool_usage；Codex 本地无记录） */
async function renderToolActivity() {
  try {
    const res = await fetch('/api/tool-activity?days=30');
    const { tools } = await res.json();
    if (!charts.toolsAct) return;
    if (!tools?.length) return markEmpty('toolsAct');
    clearEmpty('toolsAct');
    const rows = [...tools].reverse();
    // 按「调用方」堆叠上品牌色，与趋势图同一套色彩语言（此前整图一个默认蓝）
    const sources = [...new Set(rows.flatMap(r => Object.keys(r.tools || {})))];
    const series = sources.map(t => ({
      name: TOOL_LABEL[t] || t, type: 'bar', stack: 'a', barMaxWidth: 14,
      itemStyle: { color: toolColor(t, OTHER_COLOR) },
      data: rows.map(r => r.tools?.[t] || 0),
    }));
    charts.toolsAct.setOption({
      animation: false,
      grid: { left: 165, right: 40, top: 14, bottom: 44 },
      tooltip: chartTooltip('toolsAct', {
        trigger: 'axis',
        formatter: (params) => {
          const r = rows[params[0]?.dataIndex];
          if (!r) return '';
          const used = params.filter(p => p.value > 0).sort((a, b) => b.value - a.value);
          return `${esc(r.name)}<br/><b>${r.n} 次调用</b><br/>` +
            used.map(p => `${p.marker} ${esc(p.seriesName)}　${p.value}`).join('<br/>');
        },
      }),
      legend: { textStyle: { color: cssVar('--dim'), fontSize: 11 }, bottom: 0, itemWidth: 14, itemHeight: 9, itemGap: 10 },
      xAxis: { type: 'value', axisLabel: { color: cssVar('--dim') }, splitLine: { lineStyle: { color: cssVar('--gridline') } } },
      yAxis: {
        type: 'category', data: rows.map(r => r.name),
        // MCP 工具名可达 35+ 字符：轴标签截断显示，全名靠悬浮
        axisLabel: { color: cssVar('--text-soft'), fontSize: 11, width: 150, overflow: 'truncate' },
      },
      series,
    }, true);
  } catch { /* 静默 */ }
}

/** 会话钻取：某天的会话列表 + 单会话 token 曲线 */
async function loadSessions(day) {
  const dateInput = document.getElementById('sess-date');
  const d = day || dateInput.value || new Date().toLocaleDateString('sv-SE');
  if (!day) dateInput.value = d;
  document.getElementById('sess-day').textContent = `· ${d}`;
  try {
    const res = await fetch(`/api/sessions?day=${d}`);
    const { sessions } = await res.json();
    const host = document.getElementById('sessions');
    if (!sessions?.length) {
      host.innerHTML = '<div class="empty-note">当日无会话（点击趋势图柱子或切换日期）</div>';
      return;
    }
    const hh = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    host.innerHTML = `<table>
      <thead><tr><th>时间段</th><th>工具</th><th>模型</th><th>项目</th><th class="num">tokens</th><th class="num">调用</th><th class="num">峰值上下文(估)</th></tr></thead>
      <tbody>${sessions.map(s => `<tr class="sess-row" data-sid="${esc(s.session_id)}">
        <td class="dim" style="font-variant-numeric:tabular-nums">${hh(s.first_ts)}–${hh(s.last_ts)}</td>
        <td><span class="badge ${esc(s.tool)}">${esc(TOOL_LABEL[s.tool] || s.tool)}</span></td>
        <td class="ellip" title="${esc((s.models || '').split(',').filter(Boolean).map(prettyModel).join(', '))}">${esc((s.models || '').split(',').filter(Boolean).map(prettyModel).slice(0, 2).join(', ')) || '-'}</td>
        <td class="dim ellip-sm" title="${esc(s.project)}">${esc(s.project) || '-'}</td>
        <td class="num">${fmt(s.total)}</td>
        <td class="num">${s.calls}</td>
        <td class="num">${fmt(s.peak)}</td>
      </tr>`).join('')}</tbody></table>`;
    host.querySelectorAll('.sess-row').forEach(tr => {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => showSessionDetail(tr.dataset.sid));
    });
  } catch { /* 静默 */ }
}

async function showSessionDetail(sid) {
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sid)}`);
    const { events } = await res.json();
    const box = document.getElementById('sess-detail');
    if (!events?.length) return;
    box.style.display = 'block';
    charts.sess.resize();
    charts.sess.setOption({
      animation: false,
      title: { text: `${sid.slice(0, 18)}… · ${events.length} 次调用`, textStyle: { color: cssVar('--dim'), fontSize: 12 }, left: 4, top: 0 },
      grid: { left: 70, right: 20, top: 30, bottom: 30 },
      // 这条线是 symbol:'none'，没有可命中的图元 → 必须 axis 触发，否则悬浮框永远不弹
      tooltip: chartTooltip('sess', {
        trigger: 'axis',
        formatter: (params) => {
          const e = events[params?.[0]?.dataIndex];
          if (!e) return '';
          return `${new Date(e.ts).toLocaleTimeString('zh-CN')}<br/>合计 ${fmt(e.total_tokens)}<br/>输入 ${fmtShort(e.input_tokens)} · 缓存 ${fmtShort(e.cached_input)} · 输出 ${fmtShort(e.output_tokens)}`;
        },
      }),
      xAxis: { type: 'category', data: events.map(e => new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })), axisLabel: { color: cssVar('--dim'), fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: cssVar('--dim'), formatter: fmtShort }, splitLine: { lineStyle: { color: cssVar('--gridline') } } },
      // 总量曲线沿用「总量 = 绿」的语言（热力图/密度曲线同源），浅色下用深一档的绿
      series: [{
        type: 'line', data: events.map(e => e.total_tokens), smooth: true, symbol: 'none',
        areaStyle: { color: isLight() ? 'rgba(48,164,99,.15)' : 'rgba(57,211,83,.15)' },
        lineStyle: { color: isLight() ? '#30a14e' : '#39d353', width: 1.5 },
      }],
    }, true);
  } catch { /* 静默 */ }
}

document.getElementById('sess-date').addEventListener('change', () => loadSessions());
document.getElementById('export-btn').addEventListener('click', () => {
  window.open(`/api/export.csv?days=${days}`, '_blank');
});

/**
 * 逐日总 token 消耗密度曲线：纯 Canvas 手绘（ECharts line 在此构建渲染不稳定，
 * 时有时无；自绘贝塞尔平滑曲线 + 渐变填充 + 自管理悬停，行为完全确定）。
 */
function renderDensity(byDay) {
  const host = document.getElementById('ch-density');
  if (!host) return;
  if (!byDay?.length) {
    host.classList.add('empty');
    host.dataset.empty = '范围内无数据';
    host.querySelector('canvas')?.remove();
    return;
  }
  host.classList.remove('empty');
  delete host.dataset.empty;
  const W = host.clientWidth || 300, H = host.clientHeight || 120;
  const dpr = window.devicePixelRatio || 1;
  let canvas = host.querySelector('canvas');
  if (!canvas) { canvas = document.createElement('canvas'); host.appendChild(canvas); }
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const gridC = cssVar('--gridline', '#1d1d2a');
  const labelC = cssVar('--dim', '#8a8aa0');
  const lineC = isLight() ? '#30a14e' : '#39d353';
  const padL = 46, padR = 10, padT = 12, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const vals = byDay.map(d => d.total);
  const max = Math.max(...vals, 1);
  const px = (i) => padL + (byDay.length === 1 ? iw / 2 : (i / (byDay.length - 1)) * iw);
  const py = (v) => padT + ih - (v / max) * ih;

  // 横向网格线 + y 轴刻度（4 档）
  ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const y = padT + ih - (k / 4) * ih;
    ctx.strokeStyle = gridC; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = labelC;
    ctx.fillText(fmtShort(max * k / 4), padL - 6, y);
  }
  // x 轴日期（最多 8 个）
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const step = Math.max(1, Math.ceil(byDay.length / 8));
  for (let i = 0; i < byDay.length; i += step) {
    ctx.fillText(byDay[i].day.slice(5), px(i), padT + ih + 6);
  }

  // 平滑曲线（中点二次贝塞尔）+ 渐变填充
  const pts = vals.map((v, i) => [px(i), py(v)]);
  const stroke = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  };
  const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
  grad.addColorStop(0, isLight() ? 'rgba(48,164,99,.38)' : 'rgba(57, 211, 83, 0.42)');
  grad.addColorStop(1, 'rgba(57, 211, 83, 0.03)');
  stroke();
  ctx.lineTo(px(vals.length - 1), padT + ih); ctx.lineTo(px(0), padT + ih); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  stroke();
  ctx.strokeStyle = lineC; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

  // 自管理悬停（复用 heat-tip 样式）
  host.__densityData = byDay;
  if (!host.__densityTipBound) {
    host.__densityTipBound = true;
    let tip = document.createElement('div');
    tip.className = 'heat-tip';
    document.body.appendChild(tip);
    host.addEventListener('mousemove', (e) => {
      const data = host.__densityData;
      if (!data?.length) return;
      const rect = host.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const iw2 = rect.width - 46 - 10;
      const idx = Math.round(((x - 46) / iw2) * (data.length - 1));
      if (idx < 0 || idx >= data.length || x < 40) { tip.style.display = 'none'; return; }
      const d = data[idx];
      tip.innerHTML = `${d.day}<br>当日 ${fmt(d.total)} tokens`;
      tip.style.display = 'block';
      let tx = e.clientX + 12, ty = e.clientY - 40;
      if (tx + tip.offsetWidth > window.innerWidth - 8) tx = e.clientX - tip.offsetWidth - 12;
      tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
    });
    host.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
  // 窗口尺寸变化时重绘（挂到 host 上避免重复绑定）
  if (!host.__densityResize) {
    host.__densityResize = true;
    let lastH = 0;
    const ro = new ResizeObserver(() => {
      if (!host.__densityData) return;
      if (Math.abs(host.clientHeight - lastH) < 2) return; // 防追高循环
      lastH = host.clientHeight;
      renderDensity(host.__densityData);
    });
    ro.observe(host);
  }
}

function renderModel(byModel) {
  if (!byModel?.length) return markEmpty('model');
  clearEmpty('model');
  const rows = [...byModel].reverse(); // 横向条形图自下而上
  // 与按天花费共用展示名与色槽：同一模型在两张图里恒同色
  const names = rows.map(r => displayModelName(r.model) || '(未知)');
  const slots = assignSlots(names, MODEL_PALETTE.length, MODEL_SLOT);
  charts.model.setOption({
    animation: false,
    grid: { left: 130, right: 40, top: 10, bottom: 30 },
    tooltip: chartTooltip('model', {
      formatter: (p) => `${esc(p.name)}<br/>tokens ${fmt(p.value)} · ${rows[p.dataIndex].n} 次调用`,
    }),
    xAxis: { type: 'value', axisLabel: { color: cssVar('--dim'), formatter: fmtShort }, splitLine: { lineStyle: { color: cssVar('--gridline') } } },
    yAxis: { type: 'category', data: names, axisLabel: { color: cssVar('--text-soft'), fontSize: 11, width: 118, overflow: 'truncate' } },
    series: [{
      type: 'bar',
      data: rows.map((r, i) => ({ value: r.total, itemStyle: { color: MODEL_PALETTE[slots.get(names[i])], borderRadius: [0, 3, 3, 0] } })),
      barMaxWidth: 16,
      label: { show: true, position: 'right', color: cssVar('--dim'), fontSize: 11, formatter: (p) => fmtShort(p.value) },
    }],
  }, true);
}

function renderTool(byTool) {
  if (!byTool?.length) return markEmpty('tool');
  clearEmpty('tool');
  // 13 个工具的外部标签必然拥挤交叠、引线穿插：改图例置底 + 悬浮详情，环心放总量
  const total = byTool.reduce((s, r) => s + r.total, 0);
  charts.tool.setOption({
    animation: false,
    title: {
      text: fmtShort(total), subtext: '总 tokens', left: 'center', top: '32%',
      textStyle: { color: cssVar('--text'), fontSize: 18, fontWeight: 650 },
      subtextStyle: { color: cssVar('--dim'), fontSize: 11 },
    },
    legend: { textStyle: { color: cssVar('--dim'), fontSize: 11 }, bottom: 0, itemWidth: 14, itemHeight: 9, itemGap: 10 },
    tooltip: chartTooltip('tool', {
      formatter: (p) => `${esc(p.name)}<br/>tokens ${fmt(p.value)} · 占比 ${p.percent}% · ${byTool[p.dataIndex].n} 次`,
    }),
    series: [{
      type: 'pie', radius: ['44%', '66%'], center: ['50%', '40%'],
      itemStyle: { borderColor: cssVar('--panel'), borderWidth: 2 },
      label: { show: false }, labelLine: { show: false },
      data: byTool.map(r => ({ name: TOOL_LABEL[r.tool] || r.tool, value: r.total, itemStyle: { color: toolColor(r.tool, OTHER_COLOR) } })),
    }],
  }, true);
}

/** 日历热力图：绿色梯度、圆角方块、月份标签在下、每日/每周/累计三模式 */
function heatData(byDayAll) {
  const dayMap = new Map(byDayAll.map(r => [r.d, r.total]));
  if (heatMode === 'w') {
    // 每周：每天着色为其所在周（周一起始）的总量
    const weekKey = (d) => {
      const dt = new Date(d + 'T00:00:00');
      dt.setDate(dt.getDate() - (dt.getDay() + 6) % 7);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    };
    const weekTotals = new Map();
    for (const [d, v] of dayMap) {
      const k = weekKey(d);
      weekTotals.set(k, (weekTotals.get(k) || 0) + v);
    }
    return [...dayMap.keys()].map(d => [d, weekTotals.get(weekKey(d)) || 0]);
  }
  if (heatMode === 'c') {
    // 累计：每天显示自起始日以来的滚动总和
    const out = [];
    let acc = 0;
    const all = [...dayMap.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    for (const [d, v] of all) { acc += v; out.push([d, acc]); }
    return out;
  }
  return [...dayMap.entries()];
}

/**
 * 自管理 tooltip：custom series 的鼠标命中检测不可靠（实测 mousemove 不触发），
 * 改为容器 mousemove + convertFromPixel 反查日期；命中校验=光标落在格子中心半格内。
 */
function bindHeatTooltip(host, dayMap, cell) {
  host.__heatData = dayMap;
  host.__heatCell = cell;
  if (host.__tipBound) return;
  host.__tipBound = true;
  let tip = document.createElement('div');
  tip.className = 'heat-tip';
  document.body.appendChild(tip);
  const labelOf = () => heatMode === 'w' ? '所在周' : heatMode === 'c' ? '累计至当日' : '当日';
  host.addEventListener('mousemove', (e) => {
    const rect = host.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let d = null, v = null;
    try {
      const ts = charts.heat.convertFromPixel({ calendarIndex: 0 }, [x, y]);
      if (Number.isFinite(ts)) {
        const dt = new Date(ts);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        // 命中校验：反查日期的格子中心须在光标半格范围内（排除标签/空白区误报）
        const pix = charts.heat.convertToPixel({ calendarIndex: 0 }, key);
        if (pix && Math.abs(pix[0] - x) <= host.__heatCell / 2 && Math.abs(pix[1] - y) <= host.__heatCell / 2) {
          d = key;
          v = host.__heatData.get(key) || 0;
        }
      }
    } catch { /* 图表未就绪 */ }
    if (!d) { tip.style.display = 'none'; return; }
    tip.innerHTML = `${d}<br>${v > 0 ? labelOf() + ' ' + fmt(v) + ' tokens' : '无用量'}`;
    tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let tx = e.clientX + 12, ty = e.clientY - th - 10;
    if (tx + tw > window.innerWidth - 8) tx = e.clientX - tw - 12;
    if (ty < 8) ty = e.clientY + 14;
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  });
  host.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

function renderHeatmap(byDayAll) {
  if (!byDayAll?.length) return;
  // GitHub 惯例：固定显示近一年；custom series 精确绘制，栅格间距横竖严格一致
  const host = document.getElementById('ch-heat');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yearAgo = new Date(today.getTime() - 364 * 864e5);
  const start = `${yearAgo.getFullYear()}-${String(yearAgo.getMonth() + 1).padStart(2, '0')}-${String(yearAgo.getDate()).padStart(2, '0')}`;
  const end = byDayAll[byDayAll.length - 1].d;

  const nWeeks = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / 864e5 / 7) + 1);
  const availW = (host.clientWidth || 900) - 14;
  const cell = Math.max(8, Math.min(18, Math.floor(availW / nWeeks))); // 栅格步长（横竖同值）
  const gap = Math.max(2, Math.round(cell * 0.2));
  // 容器高度必须精确等于 top(6) + 7 行 × cell + bottom(26)：
  // ECharts 在 top+bottom 同时给定时把行距归一为 auto（按可用高度均分），多 1px 都会被摊进行距
  const hostH = cell * 7 + 32;
  host.style.height = hostH + 'px';
  charts.heat.resize();

  // 全日期序列（含无数据日，作为最深色阶），GitHub 式分档着色
  const dayMap = new Map(byDayAll.map(r => [r.d, r.total]));
  const data = [];
  for (let dt = new Date(start + 'T00:00:00'); dt <= new Date(end + 'T00:00:00'); dt.setDate(dt.getDate() + 1)) {
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    data.push([key, dayMap.get(key) || 0]);
  }
  const max = Math.max(...data.map(x => x[1]), 1);
  const STOPS = [heatEmpty(), ...heatColors()];
  const colorOf = (v) => {
    if (v <= 0) return HEAT_EMPTY;
    const r = v / max;
    const idx = r <= 0.15 ? 1 : r <= 0.35 ? 2 : r <= 0.6 ? 3 : r <= 0.85 ? 4 : 5;
    return STOPS[idx];
  };

  charts.heat.setOption({
    animation: false,
    calendar: {
      range: [start, end],
      left: 14, top: 6, bottom: 26,
      cellSize: [cell, cell],           // 配合容器高度精确对齐，横竖步长一致
      splitLine: { show: false },
      itemStyle: { color: 'rgba(0,0,0,0)', borderWidth: 0 }, // 底格透明，统一由 custom 绘制
      yearLabel: { show: false },
      monthLabel: { position: 'end', color: cssVar('--dim'), fontSize: 11, nameMap: 'cn',
        formatter: (p) => p.nameMap || `${p.MM}月` },
      dayLabel: { show: false },
    },
    series: [{
      type: 'custom',
      coordinateSystem: 'calendar',
      renderItem: (params, api) => {
        const p = api.coord(api.value(0)); // 单元格中心
        const s = cell - gap;             // 可见正方形边长
        // 此 ECharts 构建的 custom renderItem 不支持 roundRect（抛空错误），用 rect
        return {
          type: 'rect',
          shape: { x: p[0] - s / 2, y: p[1] - s / 2, width: s, height: s },
          style: { fill: colorOf(api.value(1)) },
        };
      },
      data,
    }],
  }, true);
  bindHeatTooltip(host, dayMap, cell);
  // 底部图例色条
  const legend = document.getElementById('heat-legend');
  if (legend) {
    legend.innerHTML = '<span>少</span>' +
      [heatEmpty(), ...heatColors()].map(c => `<i style="background:${c}"></i>`).join('') +
      '<span>多</span>';
  }
}

document.getElementById('hm-d').addEventListener('click', () => setHeatMode('d'));
document.getElementById('hm-w').addEventListener('click', () => setHeatMode('w'));
document.getElementById('hm-c').addEventListener('click', () => setHeatMode('c'));
// 容器宽度变化（拖侧栏等）时重算格子尺寸；只响应宽度变化，避免设置高度时自触发
(() => {
  const host = document.getElementById('ch-heat');
  let lastW = 0;
  new ResizeObserver(() => {
    const w = host.clientWidth;
    if (w && w !== lastW) {
      lastW = w;
      if (lastSummary) renderHeatmap(lastSummary.by_day_all);
    }
  }).observe(host);
})();
function setHeatMode(m) {
  if (heatMode === m) return;
  heatMode = m;
  document.getElementById('hm-d').classList.toggle('on', m === 'd');
  document.getElementById('hm-w').classList.toggle('on', m === 'w');
  document.getElementById('hm-c').classList.toggle('on', m === 'c');
  if (lastSummary) renderHeatmap(lastSummary.by_day_all);
}

function renderFeed(recent) {
  const host = document.getElementById('feed');
  if (!recent?.length) {
    host.innerHTML = '<div class="empty-note">范围内无请求</div>';
    return;
  }
  host.innerHTML = `<table>
    <thead><tr><th>时间</th><th>工具</th><th>模型</th><th>项目</th><th class="num">输入</th><th class="num">缓存读</th><th class="num">输出</th></tr></thead>
    <tbody>${recent.map(e => `<tr>
      <td class="dim">${hhmm(e.ts)}</td>
      <td><span class="badge ${esc(e.tool)}">${esc(TOOL_LABEL[e.tool] || e.tool)}</span></td>
      <td>${esc(prettyModel(e.model)) || '<span class="dim">-</span>'}</td>
      <td class="dim">${esc(e.project) || '-'}</td>
      <td class="num">${fmt(e.input_tokens)}</td>
      <td class="num dim">${fmt(e.cached_input)}</td>
      <td class="num">${fmt(e.output_tokens)}</td>
    </tr>`).join('')}</tbody></table>`;
}

function setTopView(view) {
  topView = view;
  const leaderboard = view === 'leaderboard';
  document.getElementById('overview-panel').hidden = leaderboard;
  document.getElementById('lb-panel').hidden = !leaderboard;
  const tab = document.getElementById('lb-tab');
  tab.classList.toggle('on', leaderboard);
  tab.setAttribute('aria-pressed', String(leaderboard));
  document.querySelectorAll('#range button[data-days]').forEach(button => {
    const selected = !leaderboard && Number(button.dataset.days) === days;
    button.classList.toggle('on', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

document.getElementById('range').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.id === 'lb-tab') {
    setTopView('leaderboard');
    loadLeaderboard();
    return;
  }
  // 主题和 CSV 是独立动作，不能被当成时间范围或改变当前面板。
  if (btn.dataset.days === undefined) return;
  days = Number(btn.dataset.days);
  setTopView('overview');
  load();
});

/* ---------- 社区排行榜 ----------
 * 数据来自远端榜单服务（经本地 /api/leaderboard 代理），与本地 summary 渲染完全独立：
 * 榜单挂了只影响这一块。昵称是其他用户输入的自由文本，展示前一律 esc()。 */
let lbPeriod = 'day';
let lbRequest = 0;

async function loadLeaderboard() {
  if (topView !== 'leaderboard') return;
  const body = document.getElementById('lb-body');
  const requestId = ++lbRequest;
  try {
    const res = await fetch(`/api/leaderboard?period=${lbPeriod}`);
    if (!res.ok) throw new Error(`服务返回 ${res.status}`);
    const data = await res.json();
    if (requestId === lbRequest) renderLeaderboard(data);
  } catch (err) {
    if (requestId === lbRequest) body.innerHTML = `<div class="empty-note">榜单获取失败：${esc(err.message)}</div>`;
  }
}

function renderLeaderboard(data) {
  const body = document.getElementById('lb-body');
  const note = document.getElementById('lb-note');
  const p = data?.participating || {};
  const b = data?.board;

  if (p.enabled) {
    note.innerHTML = p.last_error
      ? `已参与（${esc(p.name)}）· 上次上报失败：${esc(p.last_error)}，每小时自动重试`
      : `已参与（${esc(p.name)}）${b?.me_rank ? ` · 我的排名 <b>#${esc(b.me_rank)}</b>` : ' · 等待上报进入榜单'}`;
  } else {
    note.textContent = '未参与——本机数据不出网。想加入：终端执行 token-watcher leaderboard on <昵称>';
  }

  if (b?.period && b.period !== lbPeriod) {
    body.innerHTML = '<div class="empty-note">榜单服务尚未支持此周期，请更新并重启本地服务后重试。</div>';
    return;
  }
  if (!b?.rows?.length) {
    const msg = b ? '榜单暂无人上榜，来当第一个' : `榜单服务不可达${data?.error ? `（${esc(data.error)}）` : ''}`;
    body.innerHTML = `<div class="empty-note">${msg}</div>`;
    return;
  }
  const upd = new Date(b.updated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  note.innerHTML += ` <span class="dim">· ${esc(b.players)} 人上榜 · ${upd} 更新</span>`;

  const roiCell = (r) => r.roi == null
    ? '<span class="dim">—</span>'
    : `<b class="${r.roi >= 1 ? 'lb-roi-good' : 'dim'}">×${esc(r.roi)}</b>`;
  const modelWindow = { day: '今日 UTC', week: '近 7 日', month: '近 30 日' }[lbPeriod];
  const chips = (r) => {
    // 老服务未返回 models_period 时，其 models 仅代表近 7 天。
    if ((r.models_period ?? 'week') !== lbPeriod) return '<span class="dim">待上报当期模型</span>';
    return (r.models || []).slice(0, 1)
      .map(([m, pct]) => `<span class="lb-chip">${esc(prettyModel(m))} ${esc(pct)}%</span>`).join('');
  };
  const tokens = (r) => r[{ day: 'day_tokens', week: 'week_tokens', month: 'month_tokens' }[lbPeriod]] || 0;
  body.innerHTML = `<table>
    <thead><tr><th>#</th><th>昵称</th><th class="num">tokens</th><th class="num">ROI</th><th title="所选周期 Token 总量最多的模型；占比以同期全部 Token 为分母">主力模型（${modelWindow}）</th></tr></thead>
    <tbody>${b.rows.map(r => `<tr class="${b.me_rank === r.rank ? 'lb-me' : ''}" title="更新于 ${new Date(r.updated_at).toLocaleString('zh-CN')}">
      <td class="lb-rank${r.rank <= 3 ? ' top' : ''}">${esc(r.rank)}</td>
      <td class="lb-name">${esc(r.name)}</td>
      <td class="num">${fmt(tokens(r))}</td>
      <td class="num">${roiCell(r)}</td>
      <td>${chips(r) || '<span class="dim">-</span>'}</td>
    </tr>`).join('')}</tbody></table>`;
}

for (const [id, mode] of [['lb-day', 'day'], ['lb-week', 'week'], ['lb-month', 'month']]) {
  document.getElementById(id).addEventListener('click', () => {
    if (lbPeriod === mode) return;
    lbPeriod = mode;
    document.getElementById('lb-day').classList.toggle('on', mode === 'day');
    document.getElementById('lb-week').classList.toggle('on', mode === 'week');
    document.getElementById('lb-month').classList.toggle('on', mode === 'month');
    loadLeaderboard();
  });
}
setInterval(loadLeaderboard, 300_000);

/* SSE 实时更新 */
function connectSSE() {
  const es = new EventSource('/api/stream');
  const dot = document.getElementById('live');
  es.onopen = () => dot.classList.add('on');
  es.onerror = () => dot.classList.remove('on');
  let timer = null;
  es.onmessage = () => { // 防抖合并密集写入
    clearTimeout(timer);
    timer = setTimeout(load, 600);
  };
}

load();
connectSSE();
setInterval(load, 60_000); // 兜底轮询
