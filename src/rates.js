import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { HOME } from './config.js';

/**
 * WorkBuddy 积分费率自学习：
 * credit 账本（workbuddy.db.session_usage.credit_json，键 = 轮次 traceId）
 * × 我们事件表（tool=workbuddy，含 trace_id 的 token 明细）
 * → 对"纯单模型轮次"做无截距最小二乘：credits = a·新输入 + b·缓存读 + c·输出（每百万 token）。
 * 混合轮次（一轮内多模型）无法归因，跳过；样本 < 3 不拟合。
 * 实测（2026-09-13）：glm-5.3-flash 拟合残差≈credit 两位小数舍入，方法可靠。
 */

/** 3x3 线性方程组高斯消元（含部分主元） */
function solve3(A, b) {
  const M = [ [...A[0], b[0]], [...A[1], b[1]], [...A[2], b[2]] ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

export function learnWorkbuddyRates(store) {
  // 1) credit 账本
  const credits = new Map();
  try {
    const wb = new DatabaseSync(join(HOME, '.WorkBuddy/workbuddy.db'), { readOnly: true });
    for (const row of wb.prepare('SELECT credit_json FROM session_usage').all()) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(row.credit_json))) credits.set(k, v);
      } catch { /* 坏行跳过 */ }
    }
    wb.close();
  } catch { return []; }
  if (credits.size === 0) return [];

  // 2) 按 traceId 聚合我们的 token 明细
  const rows = store.db.prepare(`
    SELECT trace_id, model, SUM(input_tokens) fi, SUM(cached_input) ci, SUM(output_tokens) oi
    FROM events WHERE tool = 'workbuddy' AND trace_id IS NOT NULL
    GROUP BY trace_id, model`).all();
  const perTrace = new Map();
  for (const r of rows) {
    if (!perTrace.has(r.trace_id)) perTrace.set(r.trace_id, []);
    perTrace.get(r.trace_id).push(r);
  }
  const samples = new Map(); // model -> [[fi,ci,oi,cr], ...]
  for (const [tid, rs] of perTrace) {
    const cr = credits.get(tid);
    if (cr == null || rs.length !== 1) continue; // 只用纯单模型轮次
    const r = rs[0];
    if (!samples.has(r.model)) samples.set(r.model, []);
    samples.get(r.model).push([r.fi, r.ci, r.oi, cr]);
  }

  // 3) 逐模型最小二乘（量纲：百万 token）
  const out = [];
  for (const [model, pts] of samples) {
    if (pts.length < 3) continue;
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    for (const [fi, ci, oi, cr] of pts) {
      const x = [fi / 1e6, ci / 1e6, oi / 1e6];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j];
        b[i] += x[i] * cr;
      }
    }
    const sol = solve3(A, b);
    if (!sol) continue;
    const [a, cch, o] = sol;
    if (![a, cch, o].every(Number.isFinite) || a < 0 || cch < 0 || o < 0) continue;
    // 残差（最大绝对误差，积分）
    let maxRes = 0;
    for (const [fi, ci, oi, cr] of pts) {
      maxRes = Math.max(maxRes, Math.abs(a * fi / 1e6 + cch * ci / 1e6 + o * oi / 1e6 - cr));
    }
    store.saveRates(model, a, cch, o, pts.length);
    out.push({ model, fresh_rate: a, cache_rate: cch, out_rate: o, turns: pts.length, max_residual: maxRes });
  }
  return out;
}
