#!/usr/bin/env node
/**
 * Token Watcher — 本地多源 token 用量与配额面板
 *
 * 用法：
 *   tokenwatcher serve [--port 8787] [--no-open]   扫描 + 常驻服务 + 实时监听（默认命令）
 *   tokenwatcher scan                              全量/增量扫描一次并退出
 *   tokenwatcher today [--json|--light]            今日与累计用量摘要
 *   tokenwatcher sessions [--day D | --from F --to T] [--csv|--json] [--git] [--out F]
 *                                                  会话级统计导出（--git 挂 git 提交归因）
 *   tokenwatcher wrapped [--year 2026] [--json]    年度用量报告
 *   tokenwatcher leaderboard [on <昵称>|off|status|push|url <地址>]
 *                                                  社区排行榜（默认关闭，显式开启）
 *   tokenwatcher doctor                            环境与数据源体检
 *   tokenwatcher install-agent [--port 8787]       装成 macOS 开机自启服务
 *   tokenwatcher uninstall-agent                   停止并移除该服务
 *   tokenwatcher uninstall [--purge-data] [--yes]  摘除本机所有痕迹（数据默认保留）
 *   tokenwatcher bar [--port 8787]                 启动 macOS 菜单栏胶囊
 *   tokenwatcher --version | --help
 *
 * tokenmeter 为旧命令名，仍作为别名保留（1.2 及更早版本装的是这个名字）。
 */
import { existsSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from '../src/cliArgs.js';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { startServer } from '../src/server.js';
import { BalancePoller } from '../src/balance.js';
import { DB_PATH } from '../src/config.js';

const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;

const log = (msg) => console.log(`[token-watcher] ${msg}`);

/**
 * 常驻服务的兜底：本地只读面板最坏结果是数字变陈旧，不该因为某一轮解析/请求出错就整个消失。
 * launchd 的 KeepAlive 会把崩溃拉起来（掩盖问题），`npx token-watcher serve` 则直接死掉。
 * 只给 serve 装——scan/today 等一次性命令出错必须大声失败（非 0 退出码）。
 */
function installDaemonGuards() {
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.message ?? err}`));
  process.on('uncaughtException', (err) => log(`uncaught exception: ${err?.stack ?? err}`));
}

let parsed;
try { parsed = parseArgs(process.argv.slice(2)); }
catch (err) { console.error(`[token-watcher] ${err.message}`); process.exit(1); }
const { cmd, port, force, ...opts } = parsed;

const BANNER = `token-watcher v${VERSION}

  serve [--port P] [--no-open]     常驻面板（默认命令；未指定端口且被占时自动向后尝试）
  scan                             扫描一次并退出
  today [--json|--light]           今日用量摘要（--json 机器可读 / --light 纯 ASCII）
  sessions [--day D|--from F --to T] [--csv] [--git] [--out F]
                                   会话统计导出（--git 附 git 提交归因）
  wrapped [--year Y] [--json]      年度报告
  roi [--json]                     订阅 ROI（本月 API 等值 vs 实付）
  leaderboard [on <昵称>|off|status|push|url <地址>]
                                   社区排行榜（默认关闭；只上报聚合数字）
  doctor                           环境与数据源体检
  install-agent / uninstall-agent  macOS 开机自启
  uninstall [--purge-data] [--yes] 摘除所有本机痕迹（数据默认保留）
  bar [--port P]                   macOS 菜单栏胶囊

详见 README：https://github.com/luwill/token-watcher`;

if (opts.version) { console.log(`token-watcher v${VERSION}`); process.exit(0); }
if (opts.help) { console.log(BANNER); process.exit(0); }

// 一次性迁移：旧 ~/.token-stats → ~/.tokenmeter
const LEGACY = join(homedir(), '.token-stats');
const NEWDIR = join(homedir(), '.tokenmeter');
if (existsSync(LEGACY) && !existsSync(NEWDIR)) renameSync(LEGACY, NEWDIR);
const LEGACY_DB = join(NEWDIR, 'token-stats.db');
if (existsSync(LEGACY_DB) && !existsSync(DB_PATH)) renameSync(LEGACY_DB, DB_PATH);

const fmt = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n ?? 0);
};

/** 纯 ASCII 展示（CI/SSH 场景不依赖 UTF-8 终端与中文宽度对齐） */
const fmtA = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n ?? 0));

// 装卸服务/菜单栏与数据无关，必须在 new Store 之前返回：否则仅仅为了装个开机自启
// 就会在用户机器上建出数据库文件。
if (cmd === 'install-agent' || cmd === 'uninstall-agent' || cmd === 'bar') {
  try {
    if (cmd === 'bar') {
      const { openBar } = await import('../src/bar.js');
      openBar({ port, log });
    } else {
      const { installAgent, uninstallAgent } = await import('../src/agent.js');
      if (cmd === 'install-agent') installAgent({ port, force, log });
      else uninstallAgent({ log });
    }
  } catch (err) {
    log(err.message);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === 'uninstall') {
  const { uninstallAll } = await import('../src/uninstall.js');
  const { ok } = await uninstallAll({ log, purgeData: !!opts.purgeData, yes: !!opts.yes });
  process.exit(ok ? 0 : 1);
}

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
  // 扫描日志一律静默：--json 的 stdout 必须是纯 JSON（可管道给 jq），中文/人类模式也少噪音
  await scanner.scanAll({ quiet: true });
  const db = store.db;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = db.prepare('SELECT SUM(total_tokens) t, COUNT(*) n FROM events WHERE ts >= ?').get(start.getTime());
  const byTool = db.prepare('SELECT tool, SUM(total_tokens) t, COUNT(*) n FROM events WHERE ts >= ? GROUP BY tool ORDER BY t DESC').all(start.getTime());
  const allTime = store.countEvents();

  if (opts.json) {
    const byModel = db.prepare('SELECT model, SUM(total_tokens) t, COUNT(*) n FROM events WHERE ts >= ? GROUP BY model ORDER BY t DESC').all(start.getTime());
    console.log(JSON.stringify({
      version: VERSION,
      generated_at: new Date().toISOString(),
      today: { date: new Date().toLocaleDateString('sv-SE'), tokens: today.t || 0, requests: today.n || 0, by_tool: byTool, by_model: byModel },
      all_time: { tokens: allTime.total || 0, events: allTime.n || 0 },
    }, null, 2));
  } else if (opts.light) {
    console.log(`token-watcher today ${new Date().toLocaleDateString('sv-SE')}`);
    console.log(`tool          requests      tokens`);
    for (const r of byTool) console.log(`${r.tool.padEnd(14)}${String(r.n).padStart(8)}  ${fmtA(r.t).padStart(11)}`);
    console.log(`${'TOTAL'.padEnd(14)}${String(today.n || 0).padStart(8)}  ${fmtA(today.t || 0).padStart(11)}`);
  } else {
    log(`今日: ${fmt(today.t || 0)} tokens / ${today.n || 0} 次（${byTool.map(r => `${r.tool} ${fmt(r.t)}`).join(' | ') || '无'}）`);
  }
  store.close();
} else if (cmd === 'sessions') {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const bad = [];
  if (opts.day && !DATE.test(opts.day)) bad.push('--day');
  if (opts.from && !DATE.test(opts.from)) bad.push('--from');
  if (opts.to && !DATE.test(opts.to)) bad.push('--to');
  if (bad.length) { log(`日期格式应为 YYYY-MM-DD：${bad.join(' ')} 无效`); store.close(); process.exit(1); }
  if ((opts.from || opts.to) && !(opts.from && opts.to)) { log('--from 与 --to 需成对使用（或改用 --day）'); store.close(); process.exit(1); }

  const { buildSessions, sessionsToCsv, attachGitOutcomes } = await import('../src/sessions.js');
  let sessions = buildSessions(store.db, { day: opts.day, from: opts.from, to: opts.to });
  if (opts.git) sessions = await attachGitOutcomes(store.db, sessions);

  const format = opts.csv ? 'csv' : 'json';
  const content = format === 'csv' ? sessionsToCsv(sessions) : JSON.stringify({
    generated_at: new Date().toISOString(),
    ...(opts.day ? { day: opts.day } : {}),
    ...(opts.from ? { from: opts.from, to: opts.to } : {}),
    count: sessions.length,
    sessions,
  }, null, 2) + '\n';
  if (opts.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(opts.out, content, 'utf8');
    log(`已写入 ${opts.out}（${sessions.length} 会话）`);
  } else {
    process.stdout.write(content);
  }
  store.close();
} else if (cmd === 'wrapped') {
  const { buildWrapped, renderWrapped } = await import('../src/wrapped.js');
  const year = Number.isInteger(opts.year) && opts.year > 2000 && opts.year < 2100
    ? opts.year : new Date().getFullYear();
  const w = buildWrapped(store.db, year);
  console.log(opts.json ? JSON.stringify(w, null, 2) : renderWrapped(w));
  store.close();
} else if (cmd === 'roi') {
  const { computeRoi } = await import('../src/roi.js');
  const r = await computeRoi(store.db);
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else if (!r.configured) {
    log(r.hint
      ? `未配置订阅月费（~/.tokenmeter/subscriptions.json）；本月订阅工具 API 等值约 ¥${r.hint.sub_tools_api_cny}`
      : '未配置订阅月费（~/.tokenmeter/subscriptions.json），格式见 README');
  } else {
    console.log(`订阅 ROI（本月，汇率 USD×${r.usd_to_cny}）`);
    for (const e of r.entries) {
      const api = e.credits != null && e.api_cny <= 0 ? `积分 ${e.credits.toFixed(1)}` : `API 等值 ¥${e.api_cny < 0.01 ? e.api_cny.toFixed(4) : e.api_cny.toFixed(2)}`;
      const ratio = e.paid_cny == null ? '月费未填' : e.ratio == null ? '—' : `×${e.ratio.toFixed(1)}`;
      const paid = e.paid_cny == null ? ''.padEnd(13) : `月费 ¥${e.paid_cny.toFixed(2)}`.padEnd(13);
      console.log(`${String(e.name).padEnd(16)} ${api.padEnd(16)} ${paid} ${ratio}`);
    }
    console.log('口径：API 等值为假设性折算（订阅含速率限制、API 可能有折扣价），仅作参考');
  }
  store.close();
} else if (cmd === 'leaderboard') {
  const lb = await import('../src/leaderboard.js');
  const sub = opts.positionals?.[0] || 'status';
  const arg1 = opts.positionals?.[1];
  const usage = () => log('用法：tokenwatcher leaderboard on <昵称> | off | status | push | url <地址>');
  try {
    if (sub === 'on') {
      if (!arg1) { usage(); log('昵称为必填（1-16 个字，不含链接/@）'); store.close(); process.exit(1); }
      if (opts.url) lb.setLeaderboardConfig(store, { url: opts.url });
      lb.setLeaderboardConfig(store, { enabled: true, name: arg1 });
      log(`已加入社区排行榜：「${lb.getLeaderboardState(store).name}」`);
      log('只上报聚合数字（今日/近 7 天/近 30 天 tokens、请求次数、模型与工具占比、订阅 ROI 比值），字段清单见 README');
      const r = await lb.pushLeaderboardReport(store, { log });
      if (r.skipped) log(`首次上报跳过（${r.skipped}），下次启动服务后每小时代报`);
      else if (r.ok) log('首次上报成功，已在榜');
      else log(`首次上报失败：${r.error}（之后每小时自动重试）`);
    } else if (sub === 'off') {
      lb.setLeaderboardConfig(store, { enabled: false });
      log('已退出排行榜：本机不再上报；远端每日清理超过 30 天未更新的记录（正常调度下最迟约 31 天）');
    } else if (sub === 'push') {
      const r = await lb.pushLeaderboardReport(store, { log });
      if (r.skipped) { log(`未上报（${r.skipped}）${r.skipped === 'disabled' ? '——先用 leaderboard on <昵称> 开启' : ''}`); }
      else if (r.ok) log(`上报成功：今日 ${fmt(r.report.day_tokens)} / 近 7 天 ${fmt(r.report.week_tokens)} / 近 30 天 ${fmt(r.report.month_tokens)} tokens`);
      else { log(`上报失败：${r.error}`); store.close(); process.exit(1); }
    } else if (sub === 'url') {
      if (!/^https?:\/\/.+/.test(arg1 ?? '')) { usage(); store.close(); process.exit(1); }
      lb.setLeaderboardConfig(store, { url: arg1 });
      log(`榜单服务地址已设为 ${arg1}（自托管部署见 cloud/README.md）`);
    } else if (sub !== 'status') {
      usage(); store.close(); process.exit(1);
    } else {
      const st = lb.getLeaderboardState(store);
      log(`参与状态：${st.enabled ? `已参与（昵称「${st.name}」）` : '未参与（默认；tokenwatcher leaderboard on <昵称> 加入）'}`);
      if (st.enabled) {
        log(`榜单服务：${st.url}`);
        log(`上次上报：${st.last_push_ms ? new Date(st.last_push_ms).toLocaleString('zh-CN') : '尚未上报'}${st.last_error ? ` · 失败：${st.last_error}` : ' · 正常'}`);
      }
    }
  } catch (err) {
    log(err.message);
    store.close();
    process.exit(1);
  }
  store.close();
} else if (cmd === 'doctor') {
  const { doctorCommand } = await import('../src/doctor.js');
  const { ok } = await doctorCommand(store, { log: (m) => console.log(m) });
  store.close();
  process.exit(ok ? 0 : 1);
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

  // 未显式指定端口时，被占或不可绑定（Windows 的 Hyper-V/WinNAT 保留段会成段出现）则
  // 自动向后尝试，避免"端口被残留进程占住就起不来"；显式 --port 被占仍大声失败——
  // 用户点名要的端口，悄悄换一个更危险（菜单栏胶囊等会连不上）
  const tryListen = (p) => startServer({ store, scanner, balancePoller, port: p, log });
  let actualPort = port, server = null;
  if (opts.portExplicit) {
    server = await tryListen(port).catch((err) => {
      log(`端口 ${port} 起不来：${err.code === 'EADDRINUSE' ? '已被占用' : err.message}`);
      log('  换一个：token-watcher serve --port 8788');
      process.exit(1);
    });
  } else {
    for (let p = port; p < port + 64; p++) {
      try { server = await tryListen(p); actualPort = p; break; }
      catch (err) {
        // EADDRINUSE=被占；EACCES 多见于 Windows 的 Hyper-V/WinNAT 保留端口段——端口
        // 看似空闲却禁止绑定（CI 的 windows runner 实测踩过）。自动模式下两者都继续找
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') { log(`listen 失败：${err.message}`); process.exit(1); }
        log(`端口 ${p} ${err.code === 'EADDRINUSE' ? '被占用' : '不可绑定（系统保留段）'}，尝试 ${p + 1}…`);
      }
    }
    if (!server) { log(`端口 ${port}-${port + 63} 都不可用，放弃`); process.exit(1); }
    if (actualPort !== port) log(`实际使用端口 ${actualPort}（默认端口 ${port} 被占用）`);
  }

  // 自动打开面板：交互式终端才开（launchd/CI 下 stdout 不是 TTY）；--no-open 可关
  if (!opts.noOpen && process.stdout.isTTY) {
    const url = `http://127.0.0.1:${actualPort}`;
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
    try {
      const c = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true });
      c.on('error', () => {}); // opener 缺失是 'error' 事件而非异常，不接住会崩掉刚起好的服务
      c.unref();
      log(`已打开面板 ${url}`);
    } catch { log(`面板地址 ${url}`); }
  }
  log('实时监听已启动（FSEvents + 60s 兜底轮询），余额每 30 分钟轮询，Ctrl+C 退出');
}
