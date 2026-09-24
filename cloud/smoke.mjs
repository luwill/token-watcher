// End-to-end smoke uses synthetic data only. The receipt includes an exact cleanup SQL
// statement; the operator must run it against the named deployment after inspection.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const [baseArg, receiptPath] = process.argv.slice(2);
if (!baseArg || !receiptPath) throw new Error('Usage: node smoke.mjs <worker-url> <receipt.json>');
const base = new URL(baseArg).origin;
const id = crypto.randomUUID();
const report = { v: 1, id, name: '部署验收', day: new Date().toISOString().slice(0, 10),
  day_tokens: 1234, day_requests: 2, week_tokens: 5678, month_tokens: 12345, roi_ratio: 1.2,
  models: [['synthetic-week', 100]], models_by_period: { day: [['synthetic-day', 100]], week: [['synthetic-week', 100]], month: [['synthetic-month', 100]] }, tools: [['synthetic-tool', 100]] };
const receipt = { base, id, created_at: new Date().toISOString(), synthetic: true, checks: [],
  cleanup_sql: `DELETE FROM players WHERE id = '${id}';` };
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
save();
const call = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(20000) });
const post = (body) => call('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const check = (label) => { receipt.checks.push(label); save(); console.log('PASS ' + label); };
try {
  let response = await call('/healthz');
  assert.equal(response.status, 200); assert.equal(await response.text(), 'ok'); check('health + D1');
  response = await post(report); assert.equal(response.status, 200, await response.text()); check('synthetic report');
  response = await post(report); assert.equal(response.status, 429); check('per-ID throttle');
  for (const period of ['day', 'week', 'month']) {
    response = await call('/leaderboard?period=' + period, { headers: { 'X-Leaderboard-ID': id } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const board = await response.json();
    assert.equal(board.me.day_tokens, 1234); assert.equal(board.me.week_tokens, 5678);
    assert.equal(board.me.models_period, period); assert.equal(board.me.models[0][0], 'synthetic-' + period);
    assert.equal(board.me.month_tokens, 12345); assert.equal(board.period, period);
    assert.equal(board.me.roi, 1.2); assert.ok(board.me_rank >= 1); assert.equal(board.timezone, 'UTC');
    assert.ok(!JSON.stringify(board).includes(id)); check(period + ' board + personal rank + ID privacy');
  }
  response = await post({ ...report, id: 'invalid-id' }); assert.equal(response.status, 400); check('invalid ID rejected');
  response = await post({ ...report, day: '2000-01-01' }); assert.equal(response.status, 400); check('old day rejected');
  response = await post({ ...report, extra: 'x'.repeat(17000) }); assert.equal(response.status, 413); check('body size enforced');
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.message; throw error;
} finally { save(); }
