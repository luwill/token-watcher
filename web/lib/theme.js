/** 配色常量：工具品牌色、分类色板、热力图色阶。改色请同步 web/style.css 的徽章色。 */

export const TOOL_COLORS = {
  'claude-code': '#e07a5f', 'ccmr': '#8b7cf6', 'codex': '#34c98e',
  'zcode': '#f2c14e', 'dsh': '#4ea8de', 'workbuddy': '#f78fb3', 'grok': '#e6edf3',
};

export const TOOL_LABEL = {
  'claude-code': 'Claude Code', 'ccmr': 'ccmr', 'codex': 'Codex',
  'zcode': 'ZCode', 'dsh': 'dsh', 'workbuddy': 'WorkBuddy', 'grok': 'Grok',
};

// 深色底 #14141c 上经 validate_palette.js 校验的 8 槽分类色板：
// 相邻对最差 CVD ΔE 8.4、常视觉 ΔE 19.3、对比度全部 ≥3:1。改色请重跑校验。
export const MODEL_PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export const OTHER_COLOR = '#898781'; // 「其他」是聚合桶，用中性灰而非分类色

// 灰与红在色觉障碍下过于接近，故给聚合段叠斜纹做二次区分（不让颜色单独承载信息）
export const OTHER_DECAL = {
  symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 5],
  rotation: Math.PI / 4, color: 'rgba(0,0,0,.45)',
};

export const HEAT_COLORS = ['#0e2a1f', '#0e4429', '#006d32', '#26a641', '#39d353'];
export const HEAT_EMPTY = '#1b1b24';
