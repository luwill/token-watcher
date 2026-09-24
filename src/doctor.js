import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SOURCES, DB_PATH, DATA_DIR, isOffline } from './config.js';
import { computeHealth } from './server.js';
import { zcodeQuotaTargets } from './zcodeQuota.js';
import { readClaudeOauthToken } from './claudeUsage.js';
import { getLeaderboardState } from './leaderboard.js';

/**
 * token-watcher doctor：把面板上的健康自检带到终端，外加环境与库体检。
 * 退出码：0 = 全绿或有警示（stale/empty）；1 = 存在 error（解析失败/库损坏）。
 */
const pad = (s, n) => String(s).padEnd(n, ' ');
const ICON = { ok: '✓', empty: '·', stale: '⚠', error: '✗' };

export async function runDoctor(store, scannerStats, { log = console.log } = {}) {
  const problems = [];

  log('环境');
  const v = process.version;
  const [maj, min] = v.slice(1).split('.').map(Number);
  const nodeOk = maj > 22 || (maj === 22 && min >= 13);
  log(`  ${nodeOk ? '✓' : '✗'} node ${v}（要求 ≥22.13，node:sqlite 免 flag）`);
  if (!nodeOk) problems.push('node 版过低');
  log(`  ${isOffline() ? '⚠' : '✓'} 离线模式：${isOffline() ? '已开启（跳过汇率/牌价/余额/配额外网请求）' : '关闭'}`);

  // dsh 源依赖外部 zstd：有 dsh 数据却解不开是最常见的"整源归零"成因
  const hasDsh = !!store.db.prepare("SELECT 1 FROM events WHERE tool = 'dsh' LIMIT 1").get();
  if (hasDsh) {
    const zstd = (() => {
      try { execFileSync('zstd', ['--version'], { stdio: 'ignore', timeout: 3000 }); return true; }
      catch { return false; }
    })();
    log(`  ${zstd ? '✓' : '⚠'} 系统 zstd（dsh 多帧会话必需）：${zstd ? '可用' : '未找到，brew install zstd'}`);
  }

  log('数据库');
  const integrity = String(store.db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown');
  log(`  ${integrity === 'ok' ? '✓' : '✗'} PRAGMA quick_check: ${integrity}`);
  if (integrity !== 'ok') problems.push('数据库完整性检查失败');
  const { n, total } = store.countEvents();
  log(`  ✓ ${DB_PATH}（${n} 事件 / ${(total / 1e6).toFixed(1)}M tokens）`);
  try {
    const backups = readdirSync(join(DATA_DIR, 'backups')).filter(f => f.endsWith('.db'));
    log(`  ${backups.length ? '✓' : '⚠'} 每日备份：${backups.length ? `最近 ${backups.slice(-1)[0]}（共 ${backups.length} 份）` : '尚无（服务跑满 30 秒后生成）'}`);
  } catch { log('  ⚠ 每日备份：尚无（服务跑满 30 秒后生成）'); }

  log('数据源');
  const health = computeHealth(store.db, scannerStats || {});
  for (const h of health) {
    const src = SOURCES.find(s => s.tool === h.tool);
    const existsOnDisk = (src?.roots || []).some(r => existsSync(r));
    const icon = ICON[h.status] ?? '?';
    const tail = [];
    if (!existsOnDisk) tail.push('未安装（正常跳过）');
    if (h.status === 'stale') tail.push('文件在写但无新事件，疑似格式漂移');
    if (h.status === 'error') tail.push(`解析失败：${h.last_error ?? ''}`);
    if (h.last_error && h.status !== 'error') tail.push(`上次错误：${h.last_error}`);
    log(`  ${icon} ${pad(src?.label ?? h.tool, 12)} ${pad(h.status, 5)} 事件 ${String(h.events).padStart(7)}  ${tail.join('；')}`);
    if (h.status === 'error') problems.push(`${h.tool} 解析失败`);
  }

  // 凭证探测只报"有没有"，不打印任何值
  log('凭证（只探测存在性，不显示内容）');
  const envPath = join(homedir(), '.ccmr', '.env');
  log(`  ${existsSync(envPath) ? '✓' : '·'} ${envPath}${existsSync(envPath) ? '' : '（无 → 余额轮询跳过，不影响其他功能）'}`);
  const claudeTok = await readClaudeOauthToken().catch(() => null);
  log(`  ${claudeTok ? '✓' : '·'} Claude Code OAuth 凭证${claudeTok ? '（官方配额轮询可用）' : '（无 → 面板用 5h 窗口推算兜底）'}`);
  const zcodeTargets = await zcodeQuotaTargets().catch(() => []);
  log(`  ${zcodeTargets.length ? '✓' : '·'} ZCode coding-plan API key${zcodeTargets.length ? `（GLM 配额轮询可用，${zcodeTargets.length} 个）` : '（无 → GLM 配额卡跳过，不影响其他功能）'}`);

  // 排行榜是唯一的出网数据通道，参与状态必须可见（默认关闭也如实展示，不制造"偷偷上报"疑虑）
  log('社区排行榜');
  const lb = getLeaderboardState(store);
  if (!lb.enabled) {
    log('  · 未参与（默认；token-watcher leaderboard on <昵称> 加入，只上报聚合数字）');
  } else {
    const when = lb.last_push_ms ? new Date(lb.last_push_ms).toLocaleString('zh-CN') : '尚未上报';
    log(`  ${lb.last_error ? '⚠' : '✓'} 已参与（昵称「${lb.name}」→ ${lb.url}）`);
    log(`    上次上报 ${when}${lb.last_error ? ` · 失败：${lb.last_error}` : ''}`);
    // 上报失败只警示不置 error：可选的虚荣功能不应把整个 doctor 判红
  }

  log(problems.length ? `结论：${problems.length} 项需要处理（见上）` : '结论：未发现问题');
  return { ok: problems.length === 0, problems };
}

/** 供 bin 使用：先扫一轮拿到新鲜 parse_errors，再体检 */
export async function doctorCommand(store, { log = console.log } = {}) {
  const { Scanner } = await import('./scanner.js');
  const scanner = new Scanner(store, { log: () => {} });
  await scanner.scanAll({ quiet: true });
  return runDoctor(store, scanner.stats, { log });
}
