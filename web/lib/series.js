/**
 * 系列选择、配色分配与堆叠悬浮框（纯函数，无 DOM 依赖）。
 *
 * 口径：只展示所选范围内"真正有量"的工具/模型，最近用过的排前面；
 * 超出色板槽位的长尾归入「其他」——聚合，但不丢数据。
 */
import { esc, ymd } from './format.js';

/**
 * 挑出要单独成系列的键
 * @param {Array<{day: string}>} rows 按日期升序
 * @param {(row: object) => Object<string, number>} pick 取该日的 键 → 数值
 * @param {number} limit 独立系列上限（= 色板槽位数）
 * @returns {{keys: string[], rest: string[]}} keys 最近使用在前；rest 归入「其他」
 */
export function pickSeries(rows, pick, limit) {
  const lastUse = new Map(), total = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(pick(r) || {})) {
      if (!(v > 0)) continue; // 当日为 0 不算"用过"
      lastUse.set(k, r.day);
      total.set(k, (total.get(k) || 0) + v);
    }
  }
  // 最近使用的在前；同一天按范围内用量降序；再按名字典序，保证结果可复现
  const sorted = [...lastUse.keys()].sort((a, b) => {
    const la = lastUse.get(a), lb = lastUse.get(b);
    if (la !== lb) return la < lb ? 1 : -1;
    return (total.get(b) - total.get(a)) || (a < b ? -1 : 1);
  });
  return { keys: sorted.slice(0, limit), rest: sorted.slice(limit) };
}

/**
 * 分配色槽：颜色跟随实体本身，不跟随排名（新增实体不得让已有实体变色）
 * @param {string[]} names 本次要上色的实体（不超过 size 个）
 * @param {number} size 槽位数
 * @param {Map<string, number>} state 跨渲染保留的分配表（会被就地更新）
 * @returns {Map<string, number>} 实体 → 槽位下标
 */
export function assignSlots(names, size, state) {
  const out = new Map(), used = new Set();
  // 已分配过的先认领原槽
  for (const n of names) {
    const s = state.get(n);
    if (s != null && s < size && !used.has(s)) { out.set(n, s); used.add(s); }
  }
  // 新实体按名字典序补空槽（顺序固定 → 结果可复现）
  for (const n of [...names].sort()) {
    if (out.has(n)) continue;
    let s = 0;
    while (used.has(s) && s < size - 1) s++;
    used.add(s); out.set(n, s); state.set(n, s);
  }
  return out;
}

/**
 * 堆叠柱的 axis 悬浮框：只列当日真正有量的系列——0 的那些不属于"今天用了什么"，
 * 否则今天没用到的工具也会以 0 挂在悬浮框里。按用量降序、带合计，「其他」展开成员。
 * @param {(v: number) => string} format 数值格式化
 * @param {(rowIndex: number) => Object<string, number>} bagOf 取该日的 键 → 数值
 * @param {string[]} restKeys 归入「其他」的键
 * @param {string} otherName 「其他」系列名（无则空串）
 * @param {number} [min] 视为"有量"的下限（金额需大于半分，免得列出 ¥0.00）
 */
export function stackTipFormatter(format, bagOf, restKeys, otherName, min = 0) {
  return (params) => {
    const used = params.filter(p => p.value > min).sort((a, b) => b.value - a.value);
    const total = used.reduce((s, p) => s + p.value, 0);
    const lines = used.map((p) => {
      if (!otherName || p.seriesName !== otherName) {
        return `${p.marker} ${esc(p.seriesName)}　${format(p.value)}`;
      }
      const bag = bagOf(p.dataIndex) || {};
      const members = restKeys.filter(k => bag[k] > min).sort((a, b) => bag[b] - bag[a])
        .map(k => `${esc(k)} ${format(bag[k])}`).join('、');
      return `${p.marker} ${esc(p.seriesName)}　${format(p.value)}<br><span style="color:#8a8aa0">　${members}</span>`;
    }).join('<br>');
    return `${esc(params[0].axisValue)}<br><b>合计 ${format(total)}</b><br>${lines || '无用量'}`;
  };
}

/**
 * 日期轴：把空洞补齐成连续的日期列表。
 * 按天消耗与按天花费必须共用这一条轴——各自补洞的话类目数会不同，
 * 同一天落在两张图的不同 x 上，柱子也就无法对齐/等宽。
 */
export function dayAxis(byDay, maxDays) {
  const daysArr = [...new Set(byDay.map(d => d.day))].sort();
  if (daysArr.length === 0) return [];
  const first = new Date(daysArr[0] + 'T00:00:00');
  const last = new Date(daysArr[daysArr.length - 1] + 'T00:00:00');
  // 上限保护："全部"范围太长时不补洞直接返回
  if ((last - first) / 864e5 > 400 || daysArr.length > maxDays * 1.5) return daysArr;
  const out = [];
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) out.push(ymd(d));
  return out;
}

/** 补齐日期空洞，让 x 轴连续 */
export function fillDays(byDay, maxDays) {
  const map = new Map(byDay.map(d => [d.day, d]));
  return dayAxis(byDay, maxDays).map(k => map.get(k) || { day: k, tools: {}, total: 0 });
}
