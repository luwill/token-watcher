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

/*
 * 大数一律用字母单位 K / M / B。
 *
 * 两处容易想当然：
 * 1. 档位边界跟着单位一起变。中文的"亿"是 1e8，B 是 1e9——换单位不是逐字替换，
 *    1.23 亿要写成 123M 而不是 1.23B。
 * 2. 不足五位数（< 1e4）原样显示。此前 fmtShort 从 1e3 起就套 K，1500 显示成 "2K"：
 *    既丢了精度，又只省下一个字符。
 */

/**
 * 从小档往上找第一个放得下的档位。
 *
 * 不能按量级直接选档：toFixed 会把尾数进位到 1000（999,999 在 K 档是 "1000.0K"，
 * 999,999,999 在 M 档是 "1000.00M"），越出该档的表示范围。判据是"四舍五入后尾数
 * 仍小于 1000"，不是"原值小于档位上界"。
 *
 * @param {number} n 非负数值
 * @param {[number, string, number][]} bands 由小到大的 [除数, 后缀, 小数位]
 * @returns {string}
 */
function scale(n, bands) {
  for (const [div, sfx, d] of bands) {
    const v = (n / div).toFixed(d);
    if (parseFloat(v) < 1000) return v + sfx;
  }
  const [div, sfx, d] = bands[bands.length - 1];
  return (n / div).toFixed(d) + sfx; // 超出最高档：如实展示，不再升档
}

/** 指标卡/提示框用：精度优先，K 一位小数，M/B 两位 */
export function fmt(n) {
  n = n || 0;
  if (n < 1e4) return String(Math.round(n));
  return scale(n, [[1e3, 'K', 1], [1e6, 'M', 2], [1e9, 'B', 2]]);
}

/** 坐标轴/表格用：紧凑优先，K 取整，M/B 一位小数 */
export function fmtShort(n) {
  n = n || 0;
  if (n < 1e4) return String(Math.round(n));
  return scale(n, [[1e3, 'K', 0], [1e6, 'M', 1], [1e9, 'B', 1]]);
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
