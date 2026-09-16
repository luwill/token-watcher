/* Token Watcher 面板：fetch /api/summary 渲染，SSE 实时刷新。
 * 纯逻辑（格式化/系列选择/配色/悬浮框定位）在 lib/ 下，可被 test/run.mjs 直接 import。
 * ECharts 走全局 UMD（index.html 里的 <script>），不参与模块图。 */
import { esc, fmt, fmtShort, hhmm, ymd } from './lib/format.js';
import {
  TOOL_COLORS, TOOL_LABEL, MODEL_PALETTE, OTHER_COLOR, OTHER_DECAL, HEAT_COLORS, HEAT_EMPTY,
} from './lib/theme.js';
import { pickSeries, assignSlots, stackTipFormatter, dayAxis, fillDays } from './lib/series.js';
import { chartTooltip as makeTooltip } from './lib/tooltip.js';

let days = 7;
let heatMode = 'd';
let lastSummary = null;

const charts = {};
for (const [k, id] of [['trend', 'ch-trend'], ['model', 'ch-model'], ['tool', 'ch-tool'], ['heat', 'ch-heat'], ['toolsAct', 'ch-tools-act'], ['sess', 'sess-detail'], ['costday', 'ch-costday']]) {
  const el = document.getElementById(id);
  if (el) charts[k] = echarts.init(el, null, { renderer: 'canvas' });
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
  safe('status', () => renderStatus(s.quota, s.balances, s.wb_rates, s.recon, s.costs));
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

function renderStatus(quota, balances, rates, recon, costs) {
  const host = document.getElementById('quota-extra');
  if (!host) return;
  let html = '';

  // Codex 周配额
  const q = quota?.codex;
  if (q) {
    const d = q.data;
    html += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">Codex 周配额</span>
        <span class="q-plan">${esc(d.plan_type)}</span>
        <span class="q-reset">${d.window_minutes ? (d.window_minutes / 1440).toFixed(0) + ' 天窗口' : ''}</span></div>
      <div class="q-bar"><div class="q-fill" style="width:${Number(d.used_percent) || 0}%"></div></div>
      <div class="q-meta"><span>已用 ${(d.used_percent ?? 0).toFixed(1)}%</span>
        <span class="dim">重置 <b class="cd" data-at="${esc(d.resets_at)}">--</b></span></div>
    </div>`;
  }

  // Claude 5h 窗口
  const c5 = quota?.claude5h;
  if (c5 && c5.active) {
    html += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">Claude 5h 窗口</span><span class="q-plan cc">推算</span>
        <span class="q-reset">${c5.window_calls} 次调用</span></div>
      <div class="q-meta" style="margin-top:2px">
        <span style="font-size:20px;font-weight:650">${fmt(c5.window_tokens)}</span>
        <span class="dim">剩余 <b class="cd" data-at="${Math.floor(c5.window_ends_at / 1000)}">--</b></span>
      </div>
    </div>`;
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
        <span style="font-size:20px;font-weight:650">¥ ${Number(b.balance).toFixed(2)}</span>
        <span class="dim">${new Date(b.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span>
      </div>
      ${reconLine}
    </div>`;
  }

  // API 花费
  if (costs && (costs.today_cny > 0 || costs.all_cny > 0)) {
    const chips = esc((costs.by_tool || []).slice(0, 4)
      .map(t => `${TOOL_LABEL[t.tool] || t.tool} ¥${t.cost_cny.toFixed(2)}`).join(' · '));
    const unpriced = costs.unpriced?.length ? `<div class="recon dim" title="${esc(costs.unpriced.join(', '))}">⚠ ${costs.unpriced.length} 个模型未配价</div>` : '';
    html += `<div class="quota-card">
      <div class="quota-head"><span class="q-title">API 花费（LiteLLM 牌价）</span>
        <span class="q-reset" title="${costs.fx_ts ? '汇率时间 ' + esc(new Date(costs.fx_ts).toLocaleString('zh-CN')) : ''}">USD×${esc(costs.usd_to_cny)}${costs.fx_source === 'manual' ? '' : ' ·实时'}</span></div>
      <div class="q-meta" style="margin-top:2px">
        <span style="font-size:20px;font-weight:650">今日 ¥ ${costs.today_cny.toFixed(2)}</span>
        <span class="dim">近7天 ¥ ${costs.last7d_cny.toFixed(2)}</span>
      </div>
      <div class="recon dim" title="${chips}">${chips}</div>
      <div class="recon dim" style="margin-top:2px">ccmr 为实付 · 订阅工具为 API 等值成本</div>
      ${unpriced}
    </div>`;
  }

  // WorkBuddy 费率
  if (rates?.length) {
    const rows = rates.map(r => `<tr>
      <td>${esc(r.model)}</td><td>${r.fresh_rate.toFixed(1)}</td>
      <td class="dim">${r.cache_rate.toFixed(1)}</td><td>${r.out_rate.toFixed(1)}</td><td class="dim">${r.turns}</td>
    </tr>`).join('');
    html += `<div class="quota-card rates-card">
      <div class="quota-head"><span class="q-title">WorkBuddy 积分费率（自学习）</span>
        <span class="q-reset">积分/M token</span></div>
      <table class="rates-table"><thead><tr><th>模型</th><th>输入</th><th>缓存</th><th>输出</th><th>样本</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
  }
  host.innerHTML = html;
}

/** 按天花费（模型堆叠柱形图） */
function renderCostDay(byDay) {
  if (!charts.costday || !byDay?.length) return;
  // DeepSeek 家模型统一归并为 deepseek-v4.1-flash 展示（按用户口径）
  const displayName = (m) => m.startsWith('deepseek') ? 'deepseek-v4.1-flash' : m;
  const byDayMap = new Map(byDay.map(d => [d.day, d]));
  // 与按天消耗共用同一条日期轴（同样补洞），否则类目数不同、柱子无法对齐等宽
  const rows = dayAxis(byDay, days || 90).map((day) => {
    const models = {};
    for (const [m, c] of Object.entries(byDayMap.get(day)?.models || {})) {
      const n = displayName(m);
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
    animationDuration: 300,
    grid: { ...DAY_GRID, bottom: gridBottom(rows.length) },
    tooltip: chartTooltip('costday', {
      trigger: 'axis',
      formatter: stackTipFormatter(
        (v) => `¥${v.toFixed(2)}`, i => rows[i]?.models || {}, rest, otherName, 0.005),
    }),
    // plain（默认）会换行铺开，保证每条系列都能直接看到，不用翻页
    legend: { textStyle: { color: '#8a8aa0', fontSize: 11 }, bottom: 0, itemWidth: 14, itemHeight: 9, itemGap: 10 },
    xAxis: {
      type: 'category', data: rows.map(d => d.day.slice(5)),
      axisLabel: { color: '#8a8aa0', rotate: rows.length > 31 ? 45 : 0, fontSize: 11 },
      axisLine: { lineStyle: { color: '#262636' } },
    },
    yAxis: { type: 'value', axisLabel: { color: '#8a8aa0', formatter: (v) => '¥' + v }, splitLine: { lineStyle: { color: '#1d1d2a' } } },
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
  el.innerHTML = `<i style="background:#e6edf3"></i>Grok 进行中<b>上下文 ${fmtShort(live.grok.context_tokens)}</b>`;
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
    el.innerHTML = `<i style="background:#e0b34c"></i>${esc(s.id)} 余额<em class="warn"> 已停用</em>`;
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
  const dot = { ok: '#39d353', empty: '#55556a', stale: '#e0b34c', error: '#e0655f' };
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
    if (!at) { node.textContent = '--'; continue; }
    const ms = at * 1000 - Date.now();
    if (ms <= 0) { node.textContent = '已结束'; continue; }
    const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4), sec = Math.floor((ms % 6e4) / 1000);
    node.textContent = `${h}时${String(m).padStart(2, '0')}分${String(sec).padStart(2, '0')}秒`;
  }
}, 1000);


function renderTrend(byDay) {
  const rows = fillDays(byDay, days || 90);
  // 只画范围内真正用过的工具，最近用过的排前面（今天没用、范围内用过的仍保留，
  // 否则那天的柱子没有图例可解释）；工具数超出品牌色数量时归入「其他」
  const { keys, rest } = pickSeries(rows, r => r.tools, Object.keys(TOOL_COLORS).length);
  const slots = assignSlots(keys.filter(t => !TOOL_COLORS[t]), MODEL_PALETTE.length, TOOL_SLOT);
  const colorOf = (t) => TOOL_COLORS[t] || MODEL_PALETTE[slots.get(t)];
  const labelOf = (t) => TOOL_LABEL[t] || t;
  const otherName = rest.length ? `其他(${rest.length})` : '';
  const sumOf = (names, day) => names.reduce((s, n) => s + (day[n] || 0), 0);
  const barOf = (name, names, itemStyle) => ({
    name, type: 'bar', stack: 'x', barMaxWidth: BAR_MAX_W, itemStyle,
    data: rows.map(r => sumOf(names, r.tools) || 0),
  });
  const series = keys.map(t => barOf(labelOf(t), [t], { color: colorOf(t) }));
  if (rest.length) series.push(barOf(otherName, rest, { color: OTHER_COLOR, decal: OTHER_DECAL }));
  // 圆角只给最顶上一段
  if (series.length) series[series.length - 1].itemStyle.borderRadius = [3, 3, 0, 0];
  charts.trend.setOption({
    animationDuration: 300,
    grid: { ...DAY_GRID, bottom: gridBottom(rows.length) },
    tooltip: chartTooltip('trend', {
      trigger: 'axis',
      formatter: stackTipFormatter(fmt, i => rows[i]?.tools || {}, rest, otherName),
    }),
    // plain（默认）换行铺开，工具变多或窄屏时不把条目藏进翻页
    legend: { textStyle: { color: '#8a8aa0', fontSize: 11 }, bottom: 0, itemWidth: 14, itemHeight: 9, itemGap: 10 },
    xAxis: {
      type: 'category', data: rows.map(r => r.day.slice(5)),
      axisLabel: { color: '#8a8aa0', rotate: rows.length > 31 ? 45 : 0, fontSize: 11 },
      axisLine: { lineStyle: { color: '#262636' } },
    },
    yAxis: {
      type: 'value', axisLabel: { color: '#8a8aa0', formatter: fmtShort },
      splitLine: { lineStyle: { color: '#1d1d2a' } },
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
    if (!tools?.length || !charts.toolsAct) return;
    const rows = [...tools].reverse();
    charts.toolsAct.setOption({
      animationDuration: 300,
      grid: { left: 150, right: 40, top: 10, bottom: 30 },
      tooltip: chartTooltip('toolsAct', {
        formatter: (p) => {
          const t = tools[p.dataIndex]?.tools || {};
          const src = Object.entries(t).map(([k, v]) => `${TOOL_LABEL[k] || k} ${v}`).join(' · ');
          return `${esc(p.name)}<br/>${p.value} 次调用<br/><span style="color:#8a8aa0">${esc(src)}</span>`;
        },
      }),
      xAxis: { type: 'value', axisLabel: { color: '#8a8aa0' }, splitLine: { lineStyle: { color: '#1d1d2a' } } },
      yAxis: { type: 'category', data: rows.map(r => r.name), axisLabel: { color: '#c7c7d8', fontSize: 11 } },
      series: [{
        type: 'bar', data: rows.map(r => r.n), barMaxWidth: 14,
        itemStyle: { color: '#5aa9e6', borderRadius: [0, 3, 3, 0] },
        label: { show: true, position: 'right', color: '#8a8aa0', fontSize: 11 },
      }],
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
      host.innerHTML = '<div class="dim" style="padding:12px 8px">当日无会话（点击趋势图柱子或切换日期）</div>';
      return;
    }
    const hh = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    host.innerHTML = `<table>
      <thead><tr><th>时间段</th><th>工具</th><th>模型</th><th>项目</th><th>tokens</th><th>调用</th><th>峰值上下文(估)</th></tr></thead>
      <tbody>${sessions.map(s => `<tr class="sess-row" data-sid="${esc(s.session_id)}">
        <td class="dim" style="font-variant-numeric:tabular-nums">${hh(s.first_ts)}–${hh(s.last_ts)}</td>
        <td><span class="badge ${esc(s.tool)}">${esc(TOOL_LABEL[s.tool] || s.tool)}</span></td>
        <td class="ellip" title="${esc((s.models || '').split(',').filter(Boolean).join(', '))}">${esc((s.models || '').split(',').filter(Boolean).slice(0, 2).join(', ')) || '-'}</td>
        <td class="dim ellip-sm" title="${esc(s.project)}">${esc(s.project) || '-'}</td>
        <td>${fmt(s.total)}</td>
        <td>${s.calls}</td>
        <td>${fmt(s.peak)}</td>
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
      animationDuration: 200,
      title: { text: `${sid.slice(0, 18)}… · ${events.length} 次调用`, textStyle: { color: '#8a8aa0', fontSize: 12 }, left: 4, top: 0 },
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
      xAxis: { type: 'category', data: events.map(e => new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })), axisLabel: { color: '#8a8aa0', fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: '#8a8aa0', formatter: fmtShort }, splitLine: { lineStyle: { color: '#1d1d2a' } } },
      series: [{
        type: 'line', data: events.map(e => e.total_tokens), smooth: true, symbol: 'none',
        areaStyle: { color: 'rgba(90,169,230,.15)' }, lineStyle: { color: '#5aa9e6', width: 1.5 },
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
  if (!host || !byDay?.length) return;
  const W = host.clientWidth || 300, H = host.clientHeight || 120;
  const dpr = window.devicePixelRatio || 1;
  let canvas = host.querySelector('canvas');
  if (!canvas) { canvas = document.createElement('canvas'); host.appendChild(canvas); }
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

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
    ctx.strokeStyle = '#1d1d2a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillStyle = '#8a8aa0';
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
  grad.addColorStop(0, 'rgba(57, 211, 83, 0.42)');
  grad.addColorStop(1, 'rgba(57, 211, 83, 0.03)');
  stroke();
  ctx.lineTo(px(vals.length - 1), padT + ih); ctx.lineTo(px(0), padT + ih); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  stroke();
  ctx.strokeStyle = '#39d353'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

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
  const rows = [...byModel].reverse(); // 横向条形图自下而上
  charts.model.setOption({
    animationDuration: 300,
    grid: { left: 130, right: 40, top: 10, bottom: 30 },
    tooltip: chartTooltip('model', {
      formatter: (p) => `${esc(p.name)}<br/>tokens ${fmt(p.value)} · ${byModel[p.dataIndex].n} 次调用`,
    }),
    xAxis: { type: 'value', axisLabel: { color: '#8a8aa0', formatter: fmtShort }, splitLine: { lineStyle: { color: '#1d1d2a' } } },
    yAxis: { type: 'category', data: rows.map(r => r.model || '(未知)'), axisLabel: { color: '#c7c7d8', fontSize: 11 } },
    series: [{
      type: 'bar', data: rows.map(r => r.total), barMaxWidth: 16,
      itemStyle: { color: '#5aa9e6', borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: 'right', color: '#8a8aa0', fontSize: 11, formatter: (p) => fmtShort(p.value) },
    }],
  }, true);
}

function renderTool(byTool) {
  charts.tool.setOption({
    animationDuration: 300,
    tooltip: chartTooltip('tool', {
      formatter: (p) => `${esc(p.name)}<br/>tokens ${fmt(p.value)} · ${byTool[p.dataIndex].n} 次调用`,
    }),
    series: [{
      type: 'pie', radius: ['52%', '76%'], center: ['50%', '52%'],
      itemStyle: { borderColor: '#14141c', borderWidth: 2 },
      label: { color: '#c7c7d8', fontSize: 12, formatter: '{b}\n{d}%' },
      data: byTool.map(r => ({ name: TOOL_LABEL[r.tool] || r.tool, value: r.total, itemStyle: { color: TOOL_COLORS[r.tool] } })),
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
  const STOPS = [HEAT_EMPTY, ...HEAT_COLORS];
  const colorOf = (v) => {
    if (v <= 0) return HEAT_EMPTY;
    const r = v / max;
    const idx = r <= 0.15 ? 1 : r <= 0.35 ? 2 : r <= 0.6 ? 3 : r <= 0.85 ? 4 : 5;
    return STOPS[idx];
  };

  charts.heat.setOption({
    animationDuration: 300,
    calendar: {
      range: [start, end],
      left: 14, top: 6, bottom: 26,
      cellSize: [cell, cell],           // 配合容器高度精确对齐，横竖步长一致
      splitLine: { show: false },
      itemStyle: { color: 'rgba(0,0,0,0)', borderWidth: 0 }, // 底格透明，统一由 custom 绘制
      yearLabel: { show: false },
      monthLabel: { position: 'end', color: '#8a8aa0', fontSize: 11, nameMap: 'cn',
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
      [HEAT_EMPTY, ...HEAT_COLORS].map(c => `<i style="background:${c}"></i>`).join('') +
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
  document.getElementById('feed').innerHTML = `<table>
    <thead><tr><th>时间</th><th>工具</th><th>模型</th><th>项目</th><th>输入</th><th>缓存读</th><th>输出</th></tr></thead>
    <tbody>${recent.map(e => `<tr>
      <td class="dim">${hhmm(e.ts)}</td>
      <td><span class="badge ${esc(e.tool)}">${esc(TOOL_LABEL[e.tool] || e.tool)}</span></td>
      <td>${esc(e.model) || '<span class="dim">-</span>'}</td>
      <td class="dim">${esc(e.project) || '-'}</td>
      <td>${fmtShort(e.input_tokens)}</td>
      <td class="dim">${fmtShort(e.cached_input)}</td>
      <td>${fmtShort(e.output_tokens)}</td>
    </tr>`).join('')}</tbody></table>`;
}

document.getElementById('range').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#range button').forEach(b => b.classList.toggle('on', b === btn));
  days = Number(btn.dataset.days);
  load();
});

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
