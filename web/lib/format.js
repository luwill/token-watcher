/** 格式化与转义：面板各处共用的纯函数，无 DOM 依赖，可直接被测试 import。 */

/**
 * HTML 转义。面板整页靠 innerHTML 拼接，而插值来自本地目录名、各工具 transcript 里的
 * 模型/工具名与解析错误信息——这些都可能被提示注入影响，不能当可信内容直接拼。
 * 文本与属性值共用一套（引号一并转义）。& 必须最先替换，否则会二次转义。
 */
export function esc(v) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(v ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

/** 中文习惯的大数：亿 / 万，其余取整 */
export function fmt(n) {
  n = n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(Math.round(n));
}

/** 坐标轴/表格用的紧凑写法：亿 / M / K */
export function fmtShort(n) {
  n = n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

export const hhmm = (ts) =>
  new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * 本地时区的 YYYY-MM-DD。
 * 必须用本地各字段拼，不能用 toISOString()——后者是 UTC，东八区凌晨会算成前一天，
 * 与后端 date(ts,'localtime') 的分桶口径对不上。
 */
export function ymd(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
