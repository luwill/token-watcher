#!/usr/bin/env node
/**
 * 榜单管理（本地脚本，底层走 wrangler d1 execute）。
 *
 * 不在 Worker 上开管理接口：那会多一个凭口令就能写库的公网入口。
 * 这里的每条命令都要求本机已 `wrangler login` 且有该 D1 的写权限。
 *
 *   node admin.mjs find <昵称>            按昵称查 ID 与用量（公开榜单不返回 ID）
 *   node admin.mjs top [day|week|month]   前 20 名及其 ID
 *   node admin.mjs ban <ID> [原因]        封禁：删除玩家行与按天记录，此后上报一律 403
 *   node admin.mjs unban <ID>
 *   加 --local 操作本地开发库（wrangler dev 用的那份）。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DB_NAME = 'token-watcher-leaderboard';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** wrangler d1 execute 不支持绑定参数：字面量一律经此转义 */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const checkId = (id) => {
  if (!UUID.test(String(id))) throw new Error(`不是合法的榜单 ID：${id}`);
  return id;
};
const COLS = "id, name, day, day_tokens, week_tokens, month_tokens, datetime(updated_at / 1000, 'unixepoch') updated_utc";

export const findSql = (name) => `SELECT ${COLS} FROM players WHERE name = ${lit(name)} ORDER BY updated_at DESC`;
export const topSql = (period = 'day') => {
  const col = { day: 'day_tokens', week: 'week_tokens', month: 'month_tokens' }[period];
  if (!col) throw new Error('period 只能是 day / week / month');
  return `SELECT ${COLS} FROM players ORDER BY ${col} DESC LIMIT 20`;
};
export const banSql = (id, reason = '') => [
  `INSERT OR REPLACE INTO banned (id, reason, banned_at) VALUES (${lit(checkId(id))}, ${lit(reason.slice(0, 200))}, ${Date.now()})`,
  `DELETE FROM players WHERE id = ${lit(id)}`,
  `DELETE FROM daily WHERE id = ${lit(id)}`,
].join(';\n') + ';';
export const unbanSql = (id) => `DELETE FROM banned WHERE id = ${lit(checkId(id))};`;

function run(sql, { local }) {
  const args = ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', '--command', sql];
  execFileSync('npx', args, { stdio: 'inherit', cwd: fileURLToPath(new URL('.', import.meta.url)) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const local = argv.includes('--local');
  const [cmd, a, ...rest] = argv.filter(x => x !== '--local');
  const sql = { find: () => findSql(a), top: () => topSql(a), ban: () => banSql(a, rest.join(' ')), unban: () => unbanSql(a) }[cmd];
  if (!sql || (cmd !== 'top' && !a)) {
    console.error('用法：node admin.mjs find <昵称> | top [day|week|month] | ban <ID> [原因] | unban <ID> [--local]');
    process.exit(1);
  }
  try { run(sql(), { local }); }
  catch (err) { console.error(err.message); process.exit(1); }
}
