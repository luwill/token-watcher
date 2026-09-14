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
    stream.on('data', (chunk) => {
      const buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      let start = 0;
      let idx;
      while ((idx = buf.indexOf(0x0a, start)) !== -1) {
        onLine(buf.subarray(start, idx).toString('utf8'));
        start = idx + 1;
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
