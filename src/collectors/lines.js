import { createReadStream } from 'node:fs';

/**
 * 从字节偏移 offset 起逐行读取，onLine(line) 回调每行内容（不含换行符）。
 * 字节精确：offset 只推进到最后一个 '\n' 之后；正在写入的半行下次重读。
 * 跨 chunk 的 UTF-8 多字节字符安全（leftover 保持 Buffer）。
 * 返回 { newOffset }。
 */
export function readLinesFrom(path, offset, onLine) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start: offset });
    let pos = offset;
    let leftover = null; // Buffer
    // 超长行（内嵌图片、大段工具输出）跨很多 chunk：没见到换行前只攒 chunk，
    // 见到换行再一次性拼接。每来一块都 concat 是 O(n²) 拷贝，64MB 单行要 25 秒。
    let pending = [];
    stream.on('data', (chunk) => {
      if (chunk.indexOf(0x0a) === -1) { pending.push(chunk); return; }
      const parts = leftover ? [leftover, ...pending, chunk] : [...pending, chunk];
      pending = [];
      const buf = parts.length > 1 ? Buffer.concat(parts) : chunk;
      let start = 0;
      let idx;
      try {
        while ((idx = buf.indexOf(0x0a, start)) !== -1) {
          onLine(buf.subarray(start, idx).toString('utf8'));
          start = idx + 1;
        }
      } catch (err) {
        // data 回调不在 Promise executor 的同步调用栈内：必须显式 reject，
        // 扫描器才会回滚当前文件事务，并继续处理下一文件。
        stream.destroy();
        reject(err);
        return;
      }
      if (start > 0) {
        pos += start;
        leftover = start < buf.length ? buf.subarray(start) : null;
      } else {
        leftover = buf;
      }
    });
    stream.on('end', () => resolve({ newOffset: pos }));
    stream.on('error', reject);
  });
}
