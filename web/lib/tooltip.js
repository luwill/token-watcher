/**
 * ECharts 悬浮框的统一配置。
 *
 * 成对行布局给图表容器加了 overflow:hidden（挡 flex/ResizeObserver 反馈循环），
 * 而 ECharts 默认把 tooltip 作为该容器的子节点，柱子变高时悬浮框会被容器边缘裁掉。
 * 挂到 body 脱离裁切容器，再把坐标夹进视口，保证悬浮内容始终完整可见。
 * 只做 appendToBody 不够——图表贴顶时会改由浏览器窗口继续裁切。
 */
export const TIP_STYLE = {
  backgroundColor: '#1a1a25', borderColor: '#262636',
  textStyle: { color: '#e8e8f0', fontSize: 12 },
};

const TIP_GAP = 12;  // 悬浮框与光标的间距
const TIP_EDGE = 8;  // 悬浮框与视口边缘的最小留白

/**
 * 夹在视口内的悬浮框坐标；ECharts position 回调收发的是图表局部坐标。
 * @param {{getBoundingClientRect: () => DOMRect}} dom 图表容器
 * @param {{innerWidth: number, innerHeight: number}} [view] 视口（测试可注入）
 */
export function tooltipPosition(dom, view = globalThis) {
  return ([x, y], _params, _el, _rect, size) => {
    const box = dom.getBoundingClientRect();
    const [w, h] = size.contentSize;
    const vx = box.left + x, vy = box.top + y; // 光标 → 视口坐标
    // 优先放光标右下；视口放不下就翻到左上，最后统一夹进视口
    const left = vx + TIP_GAP + w > view.innerWidth ? vx - TIP_GAP - w : vx + TIP_GAP;
    const top = vy + TIP_GAP + h > view.innerHeight ? vy - TIP_GAP - h : vy + TIP_GAP;
    const maxX = Math.max(TIP_EDGE, view.innerWidth - w - TIP_EDGE);
    const maxY = Math.max(TIP_EDGE, view.innerHeight - h - TIP_EDGE);
    return [
      Math.min(Math.max(left, TIP_EDGE), maxX) - box.left,
      Math.min(Math.max(top, TIP_EDGE), maxY) - box.top,
    ];
  };
}

/**
 * 图表 tooltip 基础配置
 * @param {HTMLElement} dom 图表容器
 * @param {object} [extra] 其余 tooltip 选项（trigger/formatter/valueFormatter…）
 */
export const chartTooltip = (dom, extra = {}) => ({
  ...TIP_STYLE, appendToBody: true, position: tooltipPosition(dom), ...extra,
});
