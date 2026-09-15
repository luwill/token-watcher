#!/usr/bin/env node
/**
 * Token Watcher — 本地多源 token 用量与配额面板
 *
 * 用法：
 *   tokenwatcher scan          全量/增量扫描一次并退出
 *   tokenwatcher serve [--port 8787]   扫描 + 常驻服务 + 实时监听（默认命令）
 *   tokenwatcher today         打印今日与累计用量摘要
 *
 * tokenmeter 为旧命令名，仍作为别名保留（1.2 及更早版本装的是这个名字）。
 */
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { startServer } from '../src/server.js';
import { BalancePoller } from '../src/balance.js';
import { DB_PATH, DEFAULT_PORT } from '../src/config.js';

// 一次性迁移：旧 ~/.token-stats → ~/.tokenmeter
const LEGACY = join(homedir(), '.token-stats');
const NEWDIR = join(homedir(), '.tokenmeter');
if (existsSync(LEGACY) && !existsSync(NEWDIR)) renameSync(LEGACY, NEWDIR);
const LEGACY_DB = join(NEWDIR, 'token-stats.db');
if (existsSync(LEGACY_DB) && !existsSync(DB_PATH)) renameSync(LEGACY_DB, DB_PATH);

const log = (msg) => console.log(`[token-watcher] ${msg}`);

/**
 * 常驻服务的兜底：本地只读面板最坏结果是数字变陈旧，不该因为某一轮解析/请求出错就整个消失。
 * launchd 的 KeepAlive 会把崩溃拉起来（掩盖问题），`npx token-watcher serve` 则直接死掉。
 * 只给 serve 装——scan/today 是一次性命令，出错必须大声失败（非 0 退出码）。
 */
function installDaemonGuards() {
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.message ?? err}`));
  process.on('uncaughtException', (err) => log(`uncaught exception: ${err?.stack ?? err}`));
}

function parseArgs(argv) {
  const args = { cmd: 'serve', port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === 'scan' || argv[i] === 'serve' || argv[i] === 'today') args.cmd = argv[i];
    if (argv[i] === '--port' || argv[i] === '-p') args.port = Number(argv[i + 1]) || DEFAULT_PORT;
  }
  return args;
}

const fmt = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n ?? 0);
};

const { cmd, port } = parseArgs(process.argv.slice(2));
const store = new Store(DB_PATH);

if (cmd === 'scan') {
  const scanner = new Scanner(store, { log });
  await scanner.scanAll();
  for (const r of store.byTool()) {
    log(`${r.tool.padEnd(12)} ${String(r.n).padStart(6)} 次  in=${fmt(r.input)} cached=${fmt(r.cached)} cacheW=${fmt(r.cache_write)} out=${fmt(r.output)}  total=${fmt(r.total)}`);
  }
  store.close();
} else if (cmd === 'today') {
  const scanner = new Scanner(store, { log });
  await scanner.scanAll();
  const db = store.db;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = db.prepare('SELECT SUM(total_tokens) t FROM events WHERE ts >= ?').get(start.getTime());
  const byTool = db.prepare('SELECT tool, SUM(total_tokens) t FROM events WHERE ts >= ? GROUP BY tool').all(start.getTime());
  log(`今日: ${fmt(today.t || 0)} tokens（${byTool.map(r => `${r.tool} ${fmt(r.t)}`).join(' | ') || '无'}）`);
  store.close();
} else {
  installDaemonGuards();
  log(`db: ${DB_PATH}`);
  const scanner = new Scanner(store, { log });
  log('初次扫描历史数据（增量游标，仅首次较慢）…');
  await scanner.scanAll();
  for (const r of store.byTool()) {
    log(`${r.tool.padEnd(12)} ${String(r.n).padStart(6)} 次  total=${fmt(r.total)}`);
  }
  scanner.startWatching();
  const balancePoller = new BalancePoller(store, { log });
  await startServer({ store, scanner, balancePoller, port, log });
  log('实时监听已启动（FSEvents + 60s 兜底轮询），余额每 30 分钟轮询，Ctrl+C 退出');
}
