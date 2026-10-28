import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import zlib from 'node:zlib';

const execFileP = promisify(execFile);
const ZSTD_BINS = ['zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd'];
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 跨平台「如何安装 zstd」提示。dsh 多帧会话必须用外部 zstd CLI 解压，
 * 但旧报错只给了 macOS 的 `brew install zstd`，Windows/Linux 用户无解。
 * 这里按 process.platform 给出对应包管理器命令或官方二进制下载地址。
 */
export function zstdInstallHint() {
  switch (process.platform) {
    case 'win32':
      return '请安装 zstd：scoop install zstd 或 choco install zstd；也可从 https://github.com/facebook/zstd/releases 下载 zstd.exe 并加入 PATH';
    case 'darwin':
      return '请安装 zstd：brew install zstd';
    case 'linux':
      return '请安装 zstd：apt-get install -y zstd（Debian/Ubuntu）｜ dnf install -y zstd（Fedora）｜ pacman -S zstd（Arch）';
    default:
      return '请通过系统包管理器安装 zstd';
  }
}


/** Decompress a complete zstd stream, including concatenated frames. */
export async function decompressZstd(path, { bins = ZSTD_BINS } = {}) {
  for (const bin of bins) {
    try {
      const { stdout } = await execFileP(bin, ['-dc', path], {
        encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  if (typeof zlib.zstdDecompressSync === 'function') {
    const buf = await readFile(path);
    // Node's built-in decoder currently stops after the first frame. Confirm any candidate
    // boundary by successfully decoding the prefix so payload bytes resembling magic do not
    // create a false multi-frame diagnosis.
    let multi = false;
    let idx = buf.indexOf(ZSTD_MAGIC, 1);
    while (idx !== -1) {
      try {
        zlib.zstdDecompressSync(buf.subarray(0, idx));
        multi = true;
        break;
      } catch { /* A magic-like sequence inside the frame payload is not a frame boundary. */ }
      idx = buf.indexOf(ZSTD_MAGIC, idx + 1);
    }
    if (multi) throw new Error(`${path} 含多个 zstd 帧，Node 内置实现只能解第一帧。${zstdInstallHint()}`);
    return zlib.zstdDecompressSync(buf);
  }

  throw new Error(`zstd 不可用：PATH 与常见安装路径下均无 zstd。${zstdInstallHint()}`);
}

/**
 * 流式解压并逐行产出（外部 zstd CLI：spawn + 增量切行）。
 *
 * 大归档会话解压后可超 V8 字符串上限（~512MiB，issue #12：331MB 压缩档每轮扫描
 * parse error），整缓冲 + toString 的路走不通，必须边解边消费。行语义与旧的整串
 * 循环严格一致：按 \n 切分，尾部无换行的残行丢弃（压缩快照按完整行解析）。
 * 解压途中失败（文件截断/损坏）在产出结束后抛出——scanner 的逐文件事务会整体
 * 回滚，保持"坏档案是单文件错误而非静默跳过"。无 CLI 时回落内置整缓冲实现
 * （仅单帧，小文件场景；超大文件仍会撞上限，是无 CLI 环境的既有边界）。
 */
export async function* decompressZstdLines(path, { bins = ZSTD_BINS } = {}) {
  let child = null;
  for (const bin of bins) {
    const c = spawn(bin, ['-dc', path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // 'spawn' = 进程真的起来了；起不来（ENOENT 等）异步走 'error'，换下一个候选
    if (await new Promise(res => { c.on('spawn', () => res(true)); c.on('error', () => res(false)); })) {
      child = c;
      break;
    }
  }
  if (!child) {
    const text = (await decompressZstd(path, { bins })).toString('utf8');
    let start = 0, end;
    while ((end = text.indexOf('\n', start)) !== -1) { yield text.slice(start, end); start = end + 1; }
    return;
  }
  let errText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { if (errText.length < 4096) errText += d; });
  // setEncoding 后 chunk 是 string，跨 chunk 的多字节 UTF-8 由内部 StringDecoder 处理
  child.stdout.setEncoding('utf8');
  try {
    let rest = '';
    for await (const chunk of child.stdout) {
      rest += chunk;
      let i;
      while ((i = rest.indexOf('\n')) !== -1) {
        yield rest.slice(0, i);
        rest = rest.slice(i + 1);
      }
    }
    const code = await new Promise(res => child.on('close', res));
    if (code !== 0) throw new Error(`zstd 解压失败（exit ${code}）：${errText.trim().slice(0, 200)}`);
  } finally {
    if (child.exitCode === null && !child.killed) child.kill(); // 消费方提前退出时收掉子进程
  }
}
