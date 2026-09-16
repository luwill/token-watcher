import { writeFileSync, mkdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_PORT } from './config.js';

/**
 * macOS LaunchAgent 的生成与装卸。
 *
 * 为什么需要它：全局安装（npm i -g）的用户没有仓库，npm scripts 调不到，此前 README
 * 指的 `npm run install-agent` 对他们是条断路——那条命令还只负责 bootstrap，从不生成
 * plist，而 plist 也不在 files 里、不随包发布。
 *
 * 关键约束：**不能依赖 PATH**。launchd 的 PATH 是系统默认，既不含 npm 全局 bin
 * （前缀还可能被用户改过），也不保证含 homebrew；而入口脚本的 shebang 是
 * `#!/usr/bin/env node`，直接把脚本当可执行文件写进 plist，launchd 会找不到 node。
 * 所以 node 与脚本路径都在生成时固化成绝对路径。
 */

export const AGENT_LABEL = 'com.tokenwatcher.server';
/** 1.4.1 之前手写的 plist 用的标签；它占同一个端口，两个一起跑会互相抢 */
export const LEGACY_LABEL = 'com.tokenmeter.server';

const AGENT_DIR = join(homedir(), 'Library', 'LaunchAgents');
export const PLIST_PATH = join(AGENT_DIR, `${AGENT_LABEL}.plist`);
export const LOG_DIR = join(homedir(), '.tokenmeter', 'logs');

const XML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
/** 家目录含 & 的用户并不罕见。不转义会生成非法 XML，而 launchd 只是静默拒绝加载 */
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => XML[c]);

/** 包内真实的入口脚本路径（realpath：全局安装时 bin/ 下是软链） */
export function entryScript() {
  const p = join(import.meta.dirname, '..', 'bin', 'tokenwatcher.js');
  try { return realpathSync(p); } catch { return p; }
}

/** @returns {string} plist XML 文本 */
export function buildPlist({ node, script, port = DEFAULT_PORT, logDir = LOG_DIR, label = AGENT_LABEL }) {
  const argv = [node, '--no-warnings', script, 'serve', '--port', String(port)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(join(logDir, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logDir, 'server.err.log'))}</string>
</dict>
</plist>
`;
}

const domain = () => `gui/${process.getuid()}`;

function isLoaded(label) {
  try { execFileSync('launchctl', ['list', label], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function bootout(label) {
  try { execFileSync('launchctl', ['bootout', `${domain()}/${label}`], { stdio: 'ignore' }); return true; }
  catch { return false; } // 本就没加载
}

function requireDarwin() {
  if (process.platform !== 'darwin') {
    throw new Error('开机自启目前只支持 macOS（launchd）。其他平台请用 systemd / pm2 等常驻方案，或直接运行 token-watcher serve');
  }
}

export function installAgent({ port = DEFAULT_PORT, force = false, log = console.log } = {}) {
  requireDarwin();
  // 旧标签的服务监听同一个端口。装第二个不会报错，只会两边抢端口、一边反复重启，
  // 是那种"看起来装好了其实一直在坏"的状态，所以默认挡住。
  if (!force && isLoaded(LEGACY_LABEL)) {
    throw new Error(`检测到旧服务 ${LEGACY_LABEL} 正在运行，它占用同一个端口。\n`
      + `  先卸载：launchctl bootout ${domain()}/${LEGACY_LABEL}\n`
      + '  或加 --force 强行安装（两个服务会抢端口，不建议）');
  }
  const node = process.execPath;
  const script = entryScript();
  mkdirSync(AGENT_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, buildPlist({ node, script, port }));
  log(`已写入 ${PLIST_PATH}`);
  bootout(AGENT_LABEL); // 已加载时必须先卸载，否则 bootstrap 报 already loaded
  execFileSync('launchctl', ['bootstrap', domain(), PLIST_PATH], { stdio: 'inherit' });
  log(`已启动并设为开机自启（端口 ${port}，日志在 ${LOG_DIR}）`);
  log(`  停用：token-watcher uninstall-agent`);
}

export function uninstallAgent({ log = console.log } = {}) {
  requireDarwin();
  log(bootout(AGENT_LABEL) ? '已停止服务' : '服务未在运行');
  if (existsSync(PLIST_PATH)) { rmSync(PLIST_PATH); log(`已移除 ${PLIST_PATH}`); }
}
