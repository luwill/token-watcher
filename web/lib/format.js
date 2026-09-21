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

/**
 * 配额窗口按时长命名（与 Codex 自己的 /status 一致），不按 primary/secondary 位置：
 * plus 的 primary 是 5 小时窗口，pro 的 primary 却是周窗口。
 */
export function windowLabel(minutes) {
  const m = Number(minutes) || 0;
  if (m === 10080) return '每周';
  if (m > 0 && m % 1440 === 0) return `${m / 1440} 天`;
  if (m > 0 && m % 60 === 0) return `${m / 60} 小时`;
  return `${m} 分钟`;
}

/** 倒计时：紧凑的数字格式（"2天 3:08" / "3:57:18" / "57:18"）——配额卡窗口行只有
 * 约 170px 宽，"3时57分18秒"式全宽中文会把"标签 · 已用% + 重置"折成两行 */
export function fmtCountdown(ms) {
  if (!(ms > 0)) return '已结束';
  const d = Math.floor(ms / 8.64e7);
  const h = Math.floor((ms % 8.64e7) / 3.6e6);
  const m = String(Math.floor((ms % 3.6e6) / 6e4)).padStart(2, '0');
  const sec = String(Math.floor((ms % 6e4) / 1000)).padStart(2, '0');
  if (d > 0) return `${d}天 ${h}:${m}`;
  if (h > 0) return `${h}:${m}:${sec}`;
  return `${m}:${sec}`;
}
