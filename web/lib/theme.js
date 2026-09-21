/** 配色常量：工具品牌色、分类色板、热力图色阶。改色请同步 web/style.css 的徽章色。 */

// pi/opencode 两色不是随手挑的：在深色底上算过与既有七色的 CIEDE2000（含红盲/绿盲模拟），
// 取的是「加入后全集最差配对仍是原有的 ccmr/dsh（绿色盲 ΔE 5.8）」的那一组——
// 即新色没有制造出比现状更差的短板。换色请重跑同样的度量。
// antigravity(#6d6875)/kimi(#95d5b2)/qoder(#9c6644)/cursor(#f2cc8f) 同法逐一过检：
// 各向最差配对 ΔE 分别 ≥14.8 / ≥7.5 / ≥10.4 / ≥8.8（cursor vs zcode 为最差对）。
export const TOOL_COLORS = {
  'claude-code': '#e07a5f', 'ccmr': '#8b7cf6', 'codex': '#34c98e',
  'zcode': '#f2c14e', 'dsh': '#4ea8de', 'workbuddy': '#f78fb3', 'grok': '#e6edf3',
  'pi': '#2dd4bf', 'opencode': '#ff8c42',
  'antigravity': '#6d6875', 'kimi': '#95d5b2', 'qoder': '#9c6644', 'cursor': '#f2cc8f',
};

export const TOOL_LABEL = {
  'claude-code': 'Claude Code', 'ccmr': 'ccmr', 'codex': 'Codex',
  'zcode': 'ZCode', 'dsh': 'dsh', 'workbuddy': 'WorkBuddy', 'grok': 'Grok',
  'pi': 'Pi', 'opencode': 'OpenCode',
  'antigravity': 'Antigravity ≈', 'kimi': 'Kimi Code', 'qoder': 'Qoder', 'cursor': 'Cursor',
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
