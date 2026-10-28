/**
 * Chromium IndexedDB 的零依赖只读解码：LevelDB（.ldb 表 + .log WAL）→ IndexedDB 值
 * → V8 structured-clone 反序列化为 JS 值。供豆包等 Chromium 壳应用的采集器使用。
 *
 * 为什么不直接 grep 字节：
 * - .ldb 的 data block 默认 snappy 压缩，同一 block 内重复出现的键名会被编成回引，
 *   明文只剩第一次出现——按字节 grep 会系统性漏计；
 * - .log 是 32KB 分块的 WAL，一条记录跨块时中间插着 7 字节分片头，正则会被截断；
 * - 值不是 JSON 文本而是 V8 序列化流：数字是 varint/double、字符串带类型标签与长度，
 *   `{"a":1}` 这样的片段只在"应用自己把 JSON 存成字符串"时才可见。
 *
 * 读取是尽力而为：torn 的 WAL 尾、写入中的 .ldb、不认识的标签都只让对应那条值被跳过，
 * 绝不抛到采集器之外；真正的格式错误（magic 不符）由调用方决定是否当作错误。
 *
 * 布局依据（均在本机真实库上按字节核对过，见 docs/ARCHITECTURE.md 豆包一节）：
 * - 表：末尾 48B footer = metaindex handle + index handle + 填充 + 8B magic；
 *   BlockHandle.size 不含 5B trailer（1B 压缩类型 + 4B crc32c），0=raw，1=snappy；
 * - block 内 entry = varint shared、non_shared、value_len + key 增量 + value，末尾是
 *   restart 数组（n×u32 + u32 n）；
 * - WAL：block 32768B，record 头 = crc(4) len(2) type(1)，type 1/2/3/4 = FULL/FIRST/MIDDLE/LAST；
 *   负载是 write batch：seq(8) count(4) 后逐条 type(1) key(varint+bytes) [value(varint+bytes)]；
 * - IndexedDB 值 = varint 版本 + Blink 信封（ff <ver> [fe + 12B trailer]）+ V8 负载（ff 0f …）；
 *   以 ff 11 01 开头的是外置到 .blob 目录的大值，内联无负载。
 */

const MAX_OUT = 64 * 1024 * 1024; // 单块解压上限：防御性，真实块 ≤ 4MB 级
const MAX_DEPTH = 256;

export function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    if (pos >= buf.length) throw new Error('varint truncated');
    b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  } while (b & 0x80);
  return [result, pos];
}

/** snappy 原始流解压（无 framing）：varint 原长 + literal / copy1 / copy2 / copy4 标签序列 */
export function snappyDecompress(buf) {
  let [outLen, pos] = readVarint(buf, 0);
  if (outLen > MAX_OUT) throw new Error(`snappy output too large: ${outLen}`);
  const out = Buffer.allocUnsafe(outLen);
  let op = 0;
  while (pos < buf.length) {
    const tag = buf[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const nb = len - 59;
        if (pos + nb > buf.length) throw new Error('snappy literal length truncated');
        len = buf.readUIntLE(pos, nb);
        pos += nb;
      }
      len += 1;
      if (pos + len > buf.length || op + len > outLen) throw new Error('snappy literal out of range');
      buf.copy(out, op, pos, pos + len);
      pos += len;
      op += len;
      continue;
    }
    let len, offset;
    if (kind === 1) {
      if (pos + 1 > buf.length) throw new Error('snappy copy truncated');
      len = 4 + ((tag >> 2) & 7);
      offset = ((tag >> 5) << 8) | buf[pos];
      pos += 1;
    } else if (kind === 2) {
      if (pos + 2 > buf.length) throw new Error('snappy copy truncated');
      len = 1 + (tag >> 2);
      offset = buf.readUInt16LE(pos);
      pos += 2;
    } else {
      if (pos + 4 > buf.length) throw new Error('snappy copy truncated');
      len = 1 + (tag >> 2);
      offset = buf.readUInt32LE(pos);
      pos += 4;
    }
    if (offset === 0 || offset > op || op + len > outLen) throw new Error('snappy copy out of range');
    if (offset >= len) {
      out.copy(out, op, op - offset, op - offset + len);
    } else {
      // 重叠拷贝（RLE 式）：必须逐字节，Buffer.copy 对重叠区的语义是 memmove
      for (let i = 0; i < len; i++) out[op + i] = out[op - offset + i];
    }
    op += len;
  }
  if (op !== outLen) throw new Error(`snappy length mismatch: ${op} != ${outLen}`);
  return out;
}

const TABLE_MAGIC = Buffer.from('57fb808b247547db', 'hex'); // 0xdb4775248b80fb57 小端

export const isLevelTable = (buf) => buf.length >= 48 && buf.subarray(buf.length - 8).equals(TABLE_MAGIC);

function readBlock(buf, off, size) {
  if (off + size + 5 > buf.length) throw new Error('block handle out of range');
  const data = buf.subarray(off, off + size);
  const type = buf[off + size];
  if (type === 0) return data;
  if (type === 1) return snappyDecompress(data);
  throw new Error(`unsupported block compression ${type}`);
}

/** block 内逐条 entry 的 value（key 不解：IndexedDB 的键编码与我们无关） */
export function* blockEntries(block) {
  if (block.length < 4) return;
  const numRestarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - numRestarts * 4;
  if (end < 0) throw new Error('block restart array out of range');
  let p = 0;
  while (p < end) {
    let nonShared, valLen;
    [, p] = readVarint(block, p);
    [nonShared, p] = readVarint(block, p);
    [valLen, p] = readVarint(block, p);
    p += nonShared;
    if (p + valLen > end) throw new Error('block entry out of range');
    yield block.subarray(p, p + valLen);
    p += valLen;
  }
}

/** .ldb 表 → 全部 data block（已解压）。调用前用 isLevelTable 判别是否完整。 */
export function readTableBlocks(buf) {
  if (!isLevelTable(buf)) throw new Error('not a leveldb table');
  const footer = buf.subarray(buf.length - 48);
  let p = 0, ioff, isz;
  [, p] = readVarint(footer, p);
  [, p] = readVarint(footer, p); // metaindex：filter block，不用
  [ioff, p] = readVarint(footer, p);
  [isz] = readVarint(footer, p);
  const index = readBlock(buf, ioff, isz);
  const blocks = [];
  for (const handle of blockEntries(index)) {
    let off, size, q = 0;
    [off, q] = readVarint(handle, q);
    [size] = readVarint(handle, q);
    blocks.push(readBlock(buf, off, size));
  }
  return blocks;
}

const WAL_BLOCK = 32768, WAL_HEADER = 7;

/** .log WAL → 逐条完整 record 负载（跨块分片已拼接）。torn 尾部（正在写入）静默截止。 */
export function* walRecords(buf) {
  let frags = [];
  for (let base = 0; base < buf.length; base += WAL_BLOCK) {
    let p = base;
    const end = Math.min(base + WAL_BLOCK, buf.length);
    while (end - p >= WAL_HEADER) {
      const len = buf.readUInt16LE(p + 4), type = buf[p + 6];
      p += WAL_HEADER;
      if (type === 0) break; // 块尾零填充（kZeroType）
      if (p + len > end) return;
      const payload = buf.subarray(p, p + len);
      p += len;
      if (type === 1) { frags = []; yield payload; }
      else if (type === 2) { frags = [payload]; }
      else if (type === 3) { if (frags.length) frags.push(payload); }
      else if (type === 4) {
        if (frags.length) { frags.push(payload); yield Buffer.concat(frags); frags = []; }
      } else return;
    }
  }
}

/** write batch 负载 → 逐条 put 的 value（delete 条目无 value，跳过） */
export function* batchValues(rec) {
  if (rec.length < 12) return;
  let p = 12;
  while (p < rec.length) {
    const type = rec[p++];
    let klen, vlen;
    [klen, p] = readVarint(rec, p);
    p += klen;
    if (p > rec.length) return;
    if (type === 1) {
      [vlen, p] = readVarint(rec, p);
      if (p + vlen > rec.length) return;
      yield rec.subarray(p, p + vlen);
      p += vlen;
    } else if (type !== 0) return;
  }
}

/** 统一入口：按文件类型产出 IndexedDB 原始值 */
export function* leveldbValues(buf, kind) {
  if (kind === 'ldb') {
    for (const block of readTableBlocks(buf)) yield* blockEntries(block);
  } else if (kind === 'log') {
    for (const rec of walRecords(buf)) yield* batchValues(rec);
  } else {
    throw new Error(`unknown leveldb file kind ${kind}`);
  }
}

/**
 * 对象存储值 = varint 版本 + 包装值。包装值三种形态：
 *   ff 11 01 …                          外置到 .blob 目录的大值，内联无负载
 *   ff 11 02 <snappy>                   值级 snappy 压缩，解压后才是下一行的信封
 *   ff <ver> [fe + 12B trailer] ff 0f … Blink 信封 + V8 负载
 * 返回解开包装后的字节（仍含 Blink 信封，用 v8PayloadOffset 定位负载）；外置 blob、
 * 未知处理类型、连 varint 都读不出的垃圾返回 null。压缩值在解压前看不到任何明文，
 * 所以调用方的关键字快筛必须放在这一步之后。
 *
 * .blob 目录里的外置文件就是去掉 varint 版本前缀的包装值本身（实测以 ff 11 02 开头），
 * 读它们时传 prefixed=false。
 */
export function unwrapIndexedDbValue(raw, prefixed = true) {
  let p = 0;
  if (prefixed) {
    try { [, p] = readVarint(raw, 0); } catch { return null; }
  }
  if (raw[p] === 0xff && raw[p + 1] === 0x11) {
    if (raw[p + 2] === 0x02) return snappyDecompress(raw.subarray(p + 3));
    return null;
  }
  return raw;
}

/**
 * 在（已解包的）IndexedDB 值里定位 V8 负载起点（ff + 版本 13..15）。Blink 信封自身也是
 * ff 开头，但其版本号（≥17）不在 V8 范围内，不会误判。-1 = 无内联负载。
 */
export function v8PayloadOffset(value) {
  for (let i = value.indexOf(0xff); i !== -1 && i + 2 < value.length; i = value.indexOf(0xff, i + 1)) {
    const v = value[i + 1];
    if (v >= 13 && v <= 15) return i;
  }
  return -1;
}

const TAG = {
  VERIFY_OBJECT_COUNT: 0x3f, UNDEFINED: 0x5f, NULL: 0x30, TRUE: 0x54, FALSE: 0x46, HOLE: 0x2d,
  INT32: 0x49, UINT32: 0x55, DOUBLE: 0x4e, BIGINT: 0x5a,
  UTF8: 0x53, ONE_BYTE: 0x22, TWO_BYTE: 0x63,
  OBJECT_REF: 0x5e, BEGIN_OBJECT: 0x6f, END_OBJECT: 0x7b,
  BEGIN_SPARSE: 0x61, END_SPARSE: 0x40, BEGIN_DENSE: 0x41, END_DENSE: 0x24,
  DATE: 0x44, TRUE_OBJ: 0x79, FALSE_OBJ: 0x78, NUMBER_OBJ: 0x6e, BIGINT_OBJ: 0x7a, STRING_OBJ: 0x73, REGEXP: 0x52,
  BEGIN_MAP: 0x3b, END_MAP: 0x3a, BEGIN_SET: 0x27, END_SET: 0x2c,
  ARRAY_BUFFER: 0x42, RESIZABLE_AB: 0x7e, AB_TRANSFER: 0x74, SHARED_AB: 0x75, AB_VIEW: 0x56,
};

class SsvReader {
  constructor(buf, pos, version) {
    this.buf = buf;
    this.pos = pos;
    this.version = version;
    this.objects = []; // kObjectReference 的 id 表：每个对象在读到起始标签时登记
    this.depth = 0;
  }

  byte() {
    if (this.pos >= this.buf.length) throw new Error('ssv truncated');
    return this.buf[this.pos++];
  }

  bytes(n) {
    if (this.pos + n > this.buf.length) throw new Error('ssv truncated');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  varint() {
    const [v, p] = readVarint(this.buf, this.pos);
    this.pos = p;
    return v;
  }

  double() {
    if (this.pos + 8 > this.buf.length) throw new Error('ssv truncated');
    const d = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return d;
  }

  /** 读下一个标签，跳过 kPadding（双字节字符串前用于对齐） */
  tag() {
    let t;
    do { t = this.byte(); } while (t === 0x00);
    return t;
  }

  value(tag = this.tag()) {
    if (++this.depth > MAX_DEPTH) throw new Error('ssv nesting too deep');
    try { return this.read(tag); } finally { this.depth--; }
  }

  register(obj) {
    this.objects.push(obj);
    return obj;
  }

  read(t) {
    switch (t) {
      case TAG.VERIFY_OBJECT_COUNT: this.varint(); return this.value();
      case TAG.UNDEFINED: case TAG.HOLE: return undefined;
      case TAG.NULL: return null;
      case TAG.TRUE: return true;
      case TAG.FALSE: return false;
      case TAG.INT32: { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
      case TAG.UINT32: return this.varint();
      case TAG.DOUBLE: return this.double();
      case TAG.BIGINT: return this.bigint();
      case TAG.ONE_BYTE: return this.bytes(this.varint()).toString('latin1');
      case TAG.UTF8: return this.bytes(this.varint()).toString('utf8');
      case TAG.TWO_BYTE: return this.bytes(this.varint()).toString('utf16le');
      case TAG.OBJECT_REF: {
        const id = this.varint();
        if (id >= this.objects.length) throw new Error(`ssv dangling object reference ${id}`);
        return this.objects[id];
      }
      case TAG.BEGIN_OBJECT: return this.properties(this.register(Object.create(null)), TAG.END_OBJECT, 1);
      case TAG.BEGIN_SPARSE: { this.varint(); return this.properties(this.register([]), TAG.END_SPARSE, 2); }
      case TAG.BEGIN_DENSE: {
        const length = this.varint();
        const arr = this.register([]);
        for (let i = 0; i < length; i++) arr.push(this.value());
        return this.properties(arr, TAG.END_DENSE, 2);
      }
      case TAG.DATE: return this.register(new Date(this.double()));
      case TAG.TRUE_OBJ: return this.register(Object(true));
      case TAG.FALSE_OBJ: return this.register(Object(false));
      case TAG.NUMBER_OBJ: return this.register(Object(this.double()));
      case TAG.BIGINT_OBJ: return this.register(Object(this.bigint()));
      case TAG.STRING_OBJ: return this.register(Object(String(this.value())));
      case TAG.REGEXP: {
        const pattern = this.value();
        this.varint(); // flags 位集
        return this.register({ regexp: String(pattern) });
      }
      case TAG.BEGIN_MAP: {
        const map = this.register(new Map());
        for (let k = this.tag(); k !== TAG.END_MAP; k = this.tag()) map.set(this.value(k), this.value());
        this.varint();
        return map;
      }
      case TAG.BEGIN_SET: {
        const set = this.register(new Set());
        for (let k = this.tag(); k !== TAG.END_SET; k = this.tag()) set.add(this.value(k));
        this.varint();
        return set;
      }
      case TAG.ARRAY_BUFFER: return this.maybeView(this.register(Buffer.from(this.bytes(this.varint()))));
      case TAG.RESIZABLE_AB: {
        const len = this.varint();
        this.varint(); // maxByteLength
        return this.maybeView(this.register(Buffer.from(this.bytes(len))));
      }
      case TAG.AB_TRANSFER: case TAG.SHARED_AB: { this.varint(); return this.maybeView(this.register(Buffer.alloc(0))); }
      default: throw new Error(`ssv unknown tag 0x${t.toString(16)} at ${this.pos - 1}`);
    }
  }

  /** 对象/数组的属性段：键值对直到结束标签；结束标签后跟 1（对象）或 2（数组）个 varint 计数 */
  properties(target, endTag, counts) {
    for (let t = this.tag(); t !== endTag; t = this.tag()) {
      const key = this.value(t);
      target[typeof key === 'string' ? key : String(key)] = this.value();
    }
    for (let i = 0; i < counts; i++) this.varint();
    return target;
  }

  bigint() {
    const bitfield = this.varint();
    const bytes = this.bytes(Math.floor(bitfield / 2));
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    return bitfield & 1 ? -v : v;
  }

  /** ArrayBuffer 之后可紧跟一个视图标签（无 padding），把缓冲区包成 TypedArray/DataView */
  maybeView(buffer) {
    if (this.buf[this.pos] !== TAG.AB_VIEW) return buffer;
    this.pos++;
    this.byte(); // 子类型
    this.varint(); // byteOffset
    this.varint(); // byteLength
    if (this.version >= 14) this.varint(); // flags
    return buffer;
  }
}

/** 从 ff <version> 起解析一个 V8 structured-clone 值。返回 { version, value, end }。 */
export function parseSSV(buf, pos = 0) {
  if (buf[pos] !== 0xff) throw new Error('ssv header missing');
  let version;
  [version, pos] = readVarint(buf, pos + 1);
  if (version < 13 || version > 15) throw new Error(`ssv version ${version} unsupported`);
  const r = new SsvReader(buf, pos, version);
  const value = r.value();
  return { version, value, end: r.pos };
}

/** IndexedDB 原始值 → JS 值；外置 blob / 无 V8 负载返回 undefined */
export function decodeIndexedDbValue(raw, prefixed = true) {
  const bytes = unwrapIndexedDbValue(raw, prefixed);
  if (!bytes) return undefined;
  const off = v8PayloadOffset(bytes);
  if (off < 0) return undefined;
  return parseSSV(bytes, off).value;
}
