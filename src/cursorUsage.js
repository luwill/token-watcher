import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME, isOffline } from './config.js';
import { normalizeModel } from './models.js';

/**
 * Cursor 官方用量账单轮询。
 *
 * Cursor 本地不留逐请求 token（实测 state.vscdb 的 bubble tokenCount 全 0、agentKv 无
 * 用量字段），唯一权威来源是账号级 CSV 导出：
 *   GET cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens
 * 凭证全部取自本地：state.vscdb ItemTable 的 cursorAuth/accessToken（JWT）+ JWT sub 归一
 * 出 userId，拼 WorkosCursorSessionToken cookie。凭证只在服务进程内使用，不入库不进前端。
 *
 * 口径（列名按表头解析，Cursor 多次改过列序）：
 *   fresh input = "Input (w/o Cache Write)"，cache_write = "Input (w/ Cache Write)"，
 *   cached = "Cache Read"，total = 四项之和（与官方 Total Tokens 列核验相等）。
 * Cost 列不采用——全源统一走本地价格表折算，混入厂商口径会让跨源对比失义。
 *
 * dedup：CSV 行无稳定 id，用「日期|模型|五数值 + 同指纹出现序号」做指纹。重导出时
 * 数值被修正的旧行会残留（指纹变了按新行走），这是该来源的已知边界，记录在
 * ARCHITECTURE。轮询 30 分钟，失败 fail-soft 保留已入库历史。
 */
const CSV_URL = 'https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens';
const WORKOS_RE = /^(google-oauth2|github|oidc|auth0)\|[^|]+$/;

function stateDbPath() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'linux') {
    return join(process.env.XDG_CONFIG_HOME ?? join(HOME, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function normalizeSubject(sub) {
  const native = sub?.match(/\|(user_[A-Za-z0-9_]+)$/);
  if (native) return native[1];
  if (sub && WORKOS_RE.test(sub)) return sub;
  return null;
}

/** 从本地读 Cursor 会话 cookie；未装/未登录返回 null（正常态，静默跳过） */
export function extractCursorCookie() {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) return null;
  let jwt = null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    jwt = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get()?.value ?? null;
    db.close();
  } catch { return null; }
  if (!jwt || jwt.length < 10) return null;
  let sub = null;
  try {
    sub = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub;
  } catch { /* 坏 JWT */ }
  const user = normalizeSubject(sub);
  if (!user) return null;
  return `WorkosCursorSessionToken=${user}%3A%3A${jwt}`;
}

const stripQ = (s) => s.replace(/^"|"$/g, '').replace(/""/g, '"');
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ && c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
    else if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** CSV 文本 → 事件数组（列名解析，兼容 Cursor 加列改序） */
export function parseCursorCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const cols = new Map();
  splitCsvLine(lines[0]).forEach((h, i) => cols.set(stripQ(h), i));
  const need = ['Date', 'Model', 'Input (w/ Cache Write)', 'Input (w/o Cache Write)', 'Cache Read', 'Output Tokens'];
  if (need.some((n) => !cols.has(n))) return [];

  const rows = [];
  const seen = new Map(); // 指纹 → 出现序号（同值重复行按序区分）
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]).map(stripQ);
    const ts = Date.parse(f[cols.get('Date')]);
    const model = f[cols.get('Model')];
    const cacheW = Number(f[cols.get('Input (w/ Cache Write)')]) || 0;
    const input = Number(f[cols.get('Input (w/o Cache Write)')]) || 0;
    const cached = Number(f[cols.get('Cache Read')]) || 0;
    const output = Number(f[cols.get('Output Tokens')]) || 0;
    if (!Number.isFinite(ts) || !model) continue;
    if (input + cached + cacheW + output <= 0) continue;
    const fp = `${f[cols.get('Date')]}|${model}|${cacheW}|${input}|${cached}|${output}`;
    const nth = seen.get(fp) || 0;
    seen.set(fp, nth + 1);
    rows.push({
      ts,
      model: normalizeModel(model),
      input_tokens: input,
      cached_input: cached,
      cache_write: cacheW,
      output_tokens: output,
      total_tokens: input + cached + cacheW + output,
      dedup_key: `cursor:${fp}:${nth}`,
    });
  }
  return rows;
}

export class CursorUsagePoller {
  constructor(store, { log = () => {}, intervalMs = 30 * 60_000, fetchImpl = undefined, cookieImpl = undefined } = {}) {
    this.store = store;
    this.log = log;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl;
    this.cookieImpl = cookieImpl ?? extractCursorCookie;
    this.onChange = null;
    this._timer = null;
    this._lastError = null;
  }

  status() { return this._lastError ? { error: this._lastError } : null; }

  async poll() {
    if (isOffline()) return;
    const cookie = this.cookieImpl();
    if (!cookie) { this._lastError = null; return; } // 未装/未登录：静默跳过
    try {
      const res = await (this.fetchImpl ?? fetch)(CSV_URL, {
        headers: {
          Cookie: cookie,
          Referer: 'https://www.cursor.com/settings',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseCursorCsv(await res.text());
      if (!rows.length) throw Object.assign(new Error('CSV 无可识别行（列名漂移？）'), { permanent: true });
      let n = 0;
      for (const r of rows) {
        n += this.store.insertEvent({
          ...r,
          tool: 'cursor',
          session_id: null, // 账号级账单无会话维度，如实留空
          project: null,
          reasoning_tokens: 0,
        });
      }
      this._lastError = null;
      this.log(`cursor usage: ${rows.length} rows, +${n} new`);
      if (n > 0 && this.onChange) this.onChange();
    } catch (err) {
      this._lastError = err.message;
      this.log(`cursor usage: ${err.message}`);
    }
  }

  start() {
    if (isOffline()) return;
    setTimeout(() => this.poll().catch(() => {}), 20_000).unref?.();
    this._timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs);
    this._timer.unref?.();
  }

  stop() { if (this._timer) clearInterval(this._timer); }
}
