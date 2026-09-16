import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DEFAULT_PORT } from './config.js';

/**
 * macOS 菜单栏胶囊的启动。
 *
 * app bundle 随包发布（universal，~340KB），全局安装的用户无需任何工具链。
 * 此前它只存在于仓库里、且不在 files 白名单中，`npm i -g` 的用户拿不到，
 * 而指引用的 `npm run bar` 对全局安装也不可见。
 */
export function barAppPath() {
  return join(import.meta.dirname, '..', 'bin', 'token-watcher.app');
}

export function openBar({ port = DEFAULT_PORT, log = console.log } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('菜单栏胶囊是 macOS 专属功能');
  }
  const app = barAppPath();
  if (!existsSync(app)) {
    throw new Error(`找不到 ${app}\n  从仓库运行时请先编译：npm run build-bar`);
  }
  // 端口经 --args 传给 app：serve --port 9000 的用户不该拿到一个连不上的胶囊
  execFileSync('open', ['-a', app, '--args', '--port', String(port)], { stdio: 'inherit' });
  log(`菜单栏胶囊已启动（连接 127.0.0.1:${port}，从菜单里选「退出」可关闭）`);
}
