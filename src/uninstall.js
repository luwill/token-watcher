import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR } from './config.js';

/**
 * token-watcher uninstall：把装在本机上的东西摘干净。
 *
 * 1. LaunchAgent（开机自启服务，macOS）
 * 2. ~/.tokenmeter 数据目录（库/备份/日志）—— 破坏性，默认不动，
 *    --purge-data 且交互确认（或 --yes）才删
 * 3. 提示 npm 全局包的自卸命令（进程不能可靠地删掉自己所在的安装树）
 */
export async function uninstallAll({ log = console.log, purgeData = false, yes = false } = {}) {
  let failures = 0;

  if (process.platform === 'darwin') {
    try {
      const { uninstallAgent, PLIST_PATH } = await import('./agent.js');
      if (existsSync(PLIST_PATH)) {
        uninstallAgent({ log });
      } else {
        log('· 开机自启服务：未安装');
      }
    } catch (err) {
      failures++;
      log(`✗ 开机自启服务卸载失败：${err.message}`);
    }
  } else {
    log('· 开机自启服务：macOS 专属，跳过');
  }

  if (existsSync(DATA_DIR)) {
    if (!purgeData) {
      log(`· 数据目录保留：${DATA_DIR}（想连历史数据一起删，加 --purge-data）`);
    } else if (!yes) {
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q) => new Promise((r) => rl.question(q, r));
      const ans = process.stdin.isTTY ? await ask(`将删除 ${DATA_DIR}（含统计库与备份，不可恢复），确认？[y/N] `) : '';
      rl.close();
      if (String(ans).trim().toLowerCase() !== 'y') {
        log('· 已取消删除数据目录');
      } else {
        rmSync(DATA_DIR, { recursive: true, force: true });
        log(`✓ 已删除 ${DATA_DIR}`);
      }
    } else {
      rmSync(DATA_DIR, { recursive: true, force: true });
      log(`✓ 已删除 ${DATA_DIR}`);
    }
  } else {
    log('· 数据目录：不存在');
  }

  log('');
  log(`完成。最后一步（卸载 npm 包）：npm rm -g token-watcher`);
  if (existsSync(join(homedir(), 'Library', 'LaunchAgents'))) {
    // 纯提示：旧版本（≤1.4.1）可能留有旧标签的 plist
    const legacy = join(homedir(), 'Library', 'LaunchAgents', 'com.tokenmeter.server.plist');
    if (existsSync(legacy)) log(`注意：检测到旧版残留 ${legacy}，可手动删除`);
  }
  return { ok: failures === 0 };
}
