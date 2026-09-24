import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { esc, fmt, prettyModel } from '../web/lib/format.js';

export async function testLeaderboardUi(ok) {
  console.log('\n[LB UI] 远端输入与并发切换');
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', classList: { toggle() {} },
      addEventListener(_type, callback) { this.click = callback; } });
    return nodes.get(id);
  };
  const pending = [];
  const context = vm.createContext({
    document: { getElementById: node }, esc, fmt, prettyModel,
    fetch: (url) => new Promise(resolve => pending.push({ url, resolve })),
    setInterval() {}, Date, topView: 'leaderboard',
  });
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf("let lbPeriod = 'day';"), source.indexOf('/* SSE 实时更新 */'));
  vm.runInContext(section, context);
  vm.runInContext('loadLeaderboard()', context);
  const data = (label, period = 'week') => ({ participating: { enabled: true, name: label }, board: {
    rows: [{ rank: 1, name: label, day_tokens: 123, week_tokens: 456, month_tokens: 789, roi: 2,
      models_period: period, models: [[{ day: 'claude-opus-5-5', week: 'claude-opus-5', month: 'month-model' }[period], 80], ['runner-up', 20]], updated_at: Date.now() }],
    me_rank: 1, players: 1, updated_at: Date.now(),
  } });
  const settle = async (index, payload) => {
    pending[index].resolve({ ok: true, json: async () => payload });
    await new Promise(resolve => setImmediate(resolve));
  };
  node('lb-week').click();
  await settle(1, data('周榜新响应'));
  await settle(0, data('日榜旧响应'));
  ok('较慢的旧请求不覆盖新榜单', node('lb-body').innerHTML.includes('周榜新响应') &&
    !node('lb-body').innerHTML.includes('日榜旧响应'));
  node('lb-month').click();
  await settle(2, data('月榜响应', 'month'));
  ok('近 30 日按钮请求月榜并展示月总量', pending[2].url.endsWith('period=month') &&
    node('lb-body').innerHTML.includes('789') && !node('lb-body').innerHTML.includes('456'));
  ok('月榜只显示当月第一主力并标注周期', node('lb-body').innerHTML.includes('主力模型（近 30 日）') && node('lb-body').innerHTML.includes('month-model') && !node('lb-body').innerHTML.includes('runner-up'));
  context.payload = data('旧客户端', 'week');
  vm.runInContext('renderLeaderboard(payload)', context);
  ok('月榜不能用旧客户端的周模型代替', node('lb-body').innerHTML.includes('待上报当期模型') && !node('lb-body').innerHTML.includes('claude-opus-5'));
  node('lb-day').click();
  await settle(3, data('今日响应', 'day'));
  ok('日榜显示今日主力完整版本', node('lb-body').innerHTML.includes('claude-opus-5.5') && node('lb-body').innerHTML.includes('主力模型（今日 UTC）'));
  context.payload = { ...data('旧服务日榜'), board: { ...data('旧服务日榜').board, period: 'month' } };
  vm.runInContext('renderLeaderboard(payload)', context);
  ok('旧服务返回错误周期不能冒充月榜', node('lb-body').innerHTML.includes('尚未支持此周期'));
  const attack = '<img src=x onerror=alert(1)>';
  const hostile = data(attack, 'day');
  Object.assign(hostile.board, { players: attack, me_rank: attack });
  Object.assign(hostile.board.rows[0], { rank: attack, roi: attack, models: [[attack, attack]] });
  context.payload = hostile;
  vm.runInContext('renderLeaderboard(payload)', context);
  ok('自托管返回的昵称/排名/ROI/人数/占比均转义',
    !node('lb-body').innerHTML.includes('<img') && !node('lb-note').innerHTML.includes('<img') &&
    node('lb-body').innerHTML.includes('&lt;img'));
}
