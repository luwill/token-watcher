import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { SOURCES } from '../src/config.js';
import {
  readVarint, snappyDecompress, isLevelTable, blockEntries, readTableBlocks,
  walRecords, batchValues, leveldbValues, unwrapIndexedDbValue, v8PayloadOffset,
  parseSSV, decodeIndexedDbValue,
} from '../src/v8leveldb.js';
import { doubaoUsage, doubaoEvents, doubaoFileKind, collectDoubaoFile } from '../src/collectors/doubao.js';

/* ---------- 编码器：给 v8leveldb 解码器喂它自己声明的真实格式 ---------- */

const vi = (n) => { // varint
  const b = [];
  do { let v = n % 128; n = Math.floor(n / 128); if (n) v |= 128; b.push(v); } while (n);
  return Buffer.from(b);
};
/** snappy 原始流（纯 literal，无需 copy 编码）：varint 原长 + literal 标签序列 */
const snappyEncode = (buf) => {
  const out = [vi(buf.length)];
  let p = 0;
  while (p < buf.length) {
    const len = Math.min(buf.length - p, 40);
    out.push(Buffer.from([(len - 1) << 2]), buf.subarray(p, p + len));
    p += len;
  }
  return Buffer.concat(out);
};
const f64 = (n) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const zig = (n) => (n < 0 ? (-n * 2 - 1) : n * 2);
const utf8 = (s) => Buffer.from(s, 'utf8');
const str8 = (s) => Buffer.concat([Buffer.from([0x22]), vi(Buffer.byteLength(s, 'latin1')), Buffer.from(s, 'latin1')]);
const strU = (s) => Buffer.concat([Buffer.from([0x53]), vi(utf8(s).length), utf8(s)]);

/** 极简 V8 structured-clone 编码器：object/dense array/string/double/int32/primitive/ref */
class Ssv {
  constructor(version = 15) { this.version = version; this.buf = []; this.ids = new Map(); }
  bytes(b) { this.buf.push(b); return this; }
  tag(t) { this.buf.push(Buffer.from([t])); return this; }
  obj(entries) {
    const id = this.ids.size;
    this.ids.set(this.ids.size, id);
    this.tag(0x6f);
    for (const [k, v] of entries) { this.str(k); this.value(v); }
    this.tag(0x7b); this.buf.push(vi(1));
    return this;
  }
  arr(values) {
    this.ids.set(this.ids.size, this.ids.size);
    this.tag(0x41); this.buf.push(vi(values.length));
    for (const v of values) this.value(v);
    this.tag(0x24); this.buf.push(vi(2), vi(2));
    return this;
  }
  str(s) { this.buf.push(strU(s)); return this; }
  oneByte(s) { this.buf.push(str8(s)); return this; }
  dbl(n) { this.tag(0x4e); this.buf.push(f64(n)); return this; }
  int(n) { this.tag(0x49); this.buf.push(vi(zig(n))); return this; }
  u(n) { this.tag(0x55); this.buf.push(vi(n)); return this; }
  ref(id) { this.tag(0x5e); this.buf.push(vi(id)); return this; }
  undef() { this.tag(0x5f); return this; }
  nul() { this.tag(0x30); return this; }
  truthy() { this.tag(0x54); return this; }
  falsy() { this.tag(0x46); return this; }
  value(v) {
    if (Buffer.isBuffer(v)) return this.bytes(v);
    if (v === undefined) return this.undef();
    if (v === null) return this.nul();
    if (v === true) return this.truthy();
    if (v === false) return this.falsy();
    if (typeof v === 'number') return Number.isInteger(v) ? this.int(v) : this.dbl(v);
    if (typeof v === 'string') return this.str(v);
    if (Array.isArray(v)) return this.arr(v);
    if (typeof v === 'object') return this.obj(Object.entries(v));
    if (v instanceof Map) {
      this.tag(0x3b);
      for (const [k, val] of v) { this.value(k); this.value(val); }
      this.tag(0x3a); this.buf.push(vi(1));
      return this;
    }
    if (v instanceof Set) {
      this.tag(0x27);
      for (const e of v) this.value(e);
      this.tag(0x2c); this.buf.push(vi(1));
      return this;
    }
    throw new Error('unsupported ssv value');
  }
  /** 完成品：ff <version> + 负载 */
  build() { return Buffer.concat([Buffer.from([0xff]), vi(this.version), ...this.buf]); }
  /** 裸负载（嵌套进另一对象时用，不带版本前缀） */
  raw() { return Buffer.concat(this.buf); }
}

/** 数据块载荷：entries = [[key, value]…]，末尾 restart 数组（不含 type/crc trailer） */
const blockPayload = (entries) => {
  const parts = []; const restarts = [0];
  let p = 0;
  for (const [key, val] of entries) {
    parts.push(vi(0), vi(key.length), vi(val.length), key, val);
    p += key.length + val.length + vi(0).length + vi(key.length).length + vi(val.length).length;
    restarts.push(p);
  }
  restarts.pop(); // 最后一个 restart 冗余，去掉
  const body = Buffer.concat([Buffer.concat(parts), ...restarts.map((r) => { const b = Buffer.alloc(4); b.writeUInt32LE(r); return b; })]);
  const count = Buffer.alloc(4); count.writeUInt32LE(restarts.length);
  return Buffer.concat([body, count]);
};
/** 带 trailer 的落盘块：载荷 + type 字节 + 4B crc（解码端只看 type，crc 忽略） */
const blockFile = (entries, compression = 0) => {
  const payload = blockPayload(entries);
  return Buffer.concat([payload, Buffer.from([compression]), Buffer.alloc(4)]);
};
const handle = (off, size) => Buffer.concat([vi(off), vi(size)]);
const TABLE_MAGIC = Buffer.from('57fb808b247547db', 'hex');
/** .ldb 表：data blocks（可 snappy）+ index block + footer（metaindex 空 + index handle + magic） */
const ldbTable = (dataBlocks) => {
  // dataBlocks = [[payload, type]…]；handle 的 size 不含 5B trailer；块本身按 type 落盘
  const parts = []; const handles = []; let pos = 0;
  for (const [payload, type] of dataBlocks) {
    const file = type === 1 ? snappyEncode(payload) : payload;
    handles.push(handle(pos, file.length));
    parts.push(file, Buffer.from([type]), Buffer.alloc(4));
    pos += file.length + 5;
  }
  const indexPayload = blockPayload(handles.map((h, i) => [Buffer.from([i]), h]));
  const indexStart = pos;
  parts.push(indexPayload, Buffer.from([0]), Buffer.alloc(4));
  // 48B footer：metaindex handle(0,0) + index handle + 动态 padding + 8B magic
  const mh = handle(0, 0), ih = handle(indexStart, indexPayload.length);
  const footer = Buffer.concat([mh, ih, Buffer.alloc(48 - 8 - mh.length - ih.length), TABLE_MAGIC]);
  return Buffer.concat([...parts, footer]);
};
const writeBatch = (entries) => { // entries = [[key, value]…] put
  const seq = Buffer.alloc(8); const count = Buffer.alloc(4); count.writeUInt32LE(entries.length);
  const parts = [seq, count];
  for (const [k, v] of entries) parts.push(Buffer.from([1]), vi(k.length), k, vi(v.length), v);
  return Buffer.concat(parts);
};
const WAL_BLOCK = 32768, WAL_HEADER = 7;
const walRecord = (type, payload) => {
  const h = Buffer.alloc(WAL_HEADER); h.writeUInt16LE(payload.length, 4); h[6] = type;
  return Buffer.concat([h, payload]);
};
/** .log WAL：把 write-batch 负载按块边界切成 FIRST/MIDDLE/LAST 分片，块内尾部补零 */
const walFile = (batch) => {
  const max = WAL_BLOCK - WAL_HEADER;
  const chunks = [];
  for (let p = 0; p < batch.length; p += max) chunks.push(batch.subarray(p, p + max));
  const blocks = [];
  if (chunks.length === 1) {
    blocks.push(walRecord(1, chunks[0]));
  } else {
    for (let i = 0; i < chunks.length; i++) {
      const t = i === 0 ? 2 : i === chunks.length - 1 ? 4 : 3;
      const block = walRecord(t, chunks[i]);
      blocks.push(block.length < WAL_BLOCK ? Buffer.concat([block, Buffer.alloc(WAL_BLOCK - block.length)]) : block);
    }
  }
  return Buffer.concat(blocks);
};

/** IndexedDB 对象存储值形态 */
const inlineValue = (ssv) => Buffer.concat([vi(1), ssv.build()]); // varint 版本 + ff 0f …
const envelopeValue = (ssv) => Buffer.concat([vi(1), Buffer.from([0xff, 0x12, 0xfe]), Buffer.alloc(12), ssv.build()]); // ff 12 信封
const snappyValue = (ssv) => Buffer.concat([vi(1), Buffer.from([0xff, 0x11, 0x02]), snappyEncode(ssv.build())]);
const externalValue = () => Buffer.from([0x01, 0xff, 0x11, 0x01]); // 外置：无内联负载
const blobValue = (ssv) => Buffer.concat([Buffer.from([0xff, 0x11, 0x02]), snappyEncode(ssv.build())]); // .blob 文件（无版本前缀）

/** 一条机器人回复的 extra：context_window_usage + 时间/会话/模型/工作目录 */
const extra = (over = {}) => ({
  context_window_usage: JSON.stringify({ system_prompt: 4000, messages: 12000, skills: 800, tools: 200, total_window_size: 256000 }),
  create_time_ms: 1.7e12, conversation_id: 'conv-a', message_id: 'msg-1', model_id: '38',
  workspace: '/Users/louwill/proj/dashboard', ...over,
});
const stateTree = (msgs) => ({ state: { mainTaskDataMap: { t1: { receivedMessages: msgs } } } });

export async function testDoubaoLeveldb(ok) {
  const dir = mkdtempSync(join(tmpdir(), 'doubao-leveldb-'));
  const db = join(dir, 'usage.db');
  const store = new Store(db);
  const collect = async (path, tool = 'doubao') => {
    const staged = store.stageWrites();
    const r = await collectDoubaoFile(staged.store, { tool, path });
    store.db.exec('BEGIN');
    try { r.inserted = staged.replay(); store.db.exec('COMMIT'); }
    catch (e) { store.db.exec('ROLLBACK'); throw e; }
    return r;
  };
  const ev = (key) => store.db.prepare('SELECT * FROM events WHERE dedup_key = ?').get(key);
  const countByTool = (tool) => store.byTool().find(r => r.tool === tool)?.n ?? 0;
  const sumByTool = (tool) => store.byTool().find(r => r.tool === tool)?.total ?? 0;
  try {
    /* ---------- v8leveldb 原语 ---------- */
    {
      ok('varint 单/多字节往返', readVarint(Buffer.from([0x7f]), 0)[0] === 127 && readVarint(Buffer.from([0x80, 0x01]), 0)[0] === 128);
      const plain = Buffer.from('abcdef');
      ok('snappy literal 往返', snappyDecompress(snappyEncode(plain)).equals(plain));
      // copy1（kind 1）：literal "ab" 后从 offset 2 拷 4 字节（重叠 RLE：2<4 逐字节）
      const copy1 = Buffer.concat([vi(6), Buffer.from([0x04]), Buffer.from('ab'), Buffer.from([0x01, 0x02])]);
      ok('snappy copy1 重叠拷贝', snappyDecompress(copy1).toString() === 'ababab');
      // copy2（kind 2）：offset u16
      const copy2 = Buffer.concat([vi(4), Buffer.from([0x04]), Buffer.from('ab'), Buffer.from([0x02 | (1 << 2), 0x02, 0x00])]);
      ok('snappy copy2', snappyDecompress(copy2).toString() === 'abab');
      let threw = false; try { snappyDecompress(Buffer.concat([vi(4), Buffer.from([0x04]), Buffer.from('ab'), Buffer.from([0x02 | (1 << 2), 0x03, 0x00])])); } catch { threw = true; }
      ok('snappy copy 越界拒绝', threw);
      threw = false; try { snappyDecompress(Buffer.concat([vi(99), Buffer.from([0x00, 0x61])])); } catch { threw = true; }
      ok('snappy 长度不符拒绝', threw);

      const blk = blockPayload([[...Buffer.from('k1')], [...Buffer.from('k2')]].map((k, i) => [Buffer.from('key' + i), Buffer.from('val' + i)]));
      ok('blockEntries 逐条取值', [...blockEntries(blk)].map(b => b.toString()).join(',') === 'val0,val1');
      threw = false; try { [...blockEntries(Buffer.from([0, 0, 0, 0, 2, 0, 0, 0]))]; } catch { threw = true; }
      ok('block restart 越界拒绝', threw);

      const batch = writeBatch([[...Buffer.from('k')], [...Buffer.from('v')]].map((_, i) => [Buffer.from('k' + i), Buffer.from('v' + i)]));
      const wal = walFile(batch);
      const walRecs = [...walRecords(wal)];
      ok('WAL 单块 FULL 记录', walRecs.length === 1 && walRecs[0].length === batch.length);
      ok('batchValues 逐条 put 值', [...batchValues(walRecs[0])].map(b => b.toString()).join(',') === 'v0,v1');
      // 跨 32KB 分片：batch 长度 > 32768-7，FIRST 填满块 0，LAST 落在块 1
      const big = writeBatch([[Buffer.from('big'), Buffer.alloc(WAL_BLOCK - 100, 0x61)]]);
      const bigWal = walFile(big);
      const recs = [...walRecords(bigWal)];
      ok('WAL 跨块 FIRST/LAST 重组', recs.length === 1 && recs[0].equals(big));
      // 块尾零填充（kZeroType）截止
      const padded = Buffer.concat([walRecord(1, batch), Buffer.alloc(WAL_BLOCK - walRecord(1, batch).length)]);
      ok('WAL 零填充截止', [...walRecords(padded)].length === 1);
      const torn = Buffer.concat([walRecord(1, batch).subarray(0, 5), Buffer.alloc(10)]);
      ok('WAL torn 头静默截止', [...walRecords(torn)].length === 0);
      const truncated = Buffer.concat([walRecord(1, batch), Buffer.alloc(WAL_BLOCK - walRecord(1, batch).length + 20)]);
      ok('WAL 半块空尾不抛', [...walRecords(truncated)].length === 1);
    }

    /* ---------- SSV 解析 ---------- */
    {
      const v = new Ssv().obj([['a', 1.5], ['b', 'hi'], ['c', -7], ['d', true], ['e', null]]).build();
      const d = parseSSV(v, 0);
      ok('SSV 对象混合字段', d.value.a === 1.5 && d.value.b === 'hi' && d.value.c === -7 && d.value.d === true && d.value.e === null);
      ok('SSV 版本读出', d.version === 15);
      const nested = new Ssv().obj([['x', new Ssv().obj([['y', [1, 2, 3]]]).raw()]]).build();
      ok('SSV 嵌套对象与稠密数组', JSON.stringify(parseSSV(nested, 0).value.x) === '{"y":[1,2,3]}');
      const utf = new Ssv().obj([['s', '中文']]).build();
      ok('SSV UTF8 中文', parseSSV(utf, 0).value.s === '中文');
      const one = new Ssv().oneByte('latin1').build();
      ok('SSV one-byte 字符串', parseSSV(one, 0).value === 'latin1');
      const self2 = Buffer.concat([Buffer.from([0xff, 0x0f, 0x6f]), strU('self'), Buffer.from([0x5e, 0x00, 0x7b, 0x01])]);
      ok('SSV 自引用对象不炸', (() => { const o = parseSSV(self2, 0).value; return o.self === o; })());
      let threw = false; try { parseSSV(Buffer.from([0xff, 0x0f, 0x77]), 0); } catch { threw = true; }
      ok('SSV 未知标签抛错', threw);
    }

    /* ---------- IndexedDB 值形态 ---------- */
    {
      const payload = () => new Ssv().obj([['n', 42]]).build();
      const raw = Buffer.concat([vi(1), payload()]);
      ok('decode 内联 ff 0f', decodeIndexedDbValue(raw).n === 42);
      const env = envelopeValue(new Ssv().obj([['n', 42]]));
      ok('decode Blink 信封(ff 12 fe+trailer)', decodeIndexedDbValue(env).n === 42);
      const sn = snappyValue(new Ssv().obj([['n', 42]]));
      ok('decode 值级 snappy (ff 11 02)', decodeIndexedDbValue(sn).n === 42);
      ok('decode 外置 ff 11 01 → undefined', decodeIndexedDbValue(externalValue()) === undefined);
      ok('decode 垃圾字节 → undefined', decodeIndexedDbValue(Buffer.from([0x01, 0x02, 0x03])) === undefined);
      ok('v8PayloadOffset 忽略 ff 11 信封', v8PayloadOffset(Buffer.concat([Buffer.from([0xff, 0x11, 0xfe]), Buffer.alloc(12), payload()])) > 0);
      ok('v8PayloadOffset 无负载返回 -1', v8PayloadOffset(Buffer.from([0xff, 0x11, 0xfe, 0x00])) === -1);
      ok('unwrap 外置判定', unwrapIndexedDbValue(externalValue()) === null);
      const blob = blobValue(new Ssv().obj([['n', 42]]));
      ok('blob 文件(无版本前缀)解码', decodeIndexedDbValue(blob, false).n === 42);
    }

    /* ---------- .ldb 表 ---------- */
    {
      const v1 = inlineValue(new Ssv().obj([['a', 1]]));
      const v2 = inlineValue(new Ssv().obj([['b', 2]]));
      const table = ldbTable([[blockPayload([[Buffer.from('k1'), v1]]), 1], [blockPayload([[Buffer.from('k2'), v2]]), 0]]);
      ok('ldb magic 判别', isLevelTable(table));
      const vals = [...leveldbValues(table, 'ldb')].map(b => decodeIndexedDbValue(b).b ?? decodeIndexedDbValue(b).a);
      ok('ldb 双块 raw+snappy 解码', vals.join(',') === '1,2');
      ok('非 leveldb 表拒绝', (() => { let t = false; try { readTableBlocks(Buffer.alloc(100)); } catch { t = true; } return t; })());
    }

    /* ---------- doubaoUsage / doubaoEvents ---------- */
    {
      const u = doubaoUsage(extra().context_window_usage);
      ok('doubaoUsage 四项求和', u.input === 17000);
      ok('doubaoUsage 显式 total 优先', doubaoUsage({ system_prompt: 1, messages: 1, skills: 1, tools: 1, total_tokens: 999 }).input === 999);
      ok('doubaoUsage used_tokens 兜底', doubaoUsage({ used_tokens: 888 }).input === 888);
      ok('doubaoUsage 缺项不算', doubaoUsage({ system_prompt: 'x', messages: undefined }) === null);
      ok('doubaoUsage 总和 0 → null', doubaoUsage({}) === null);
      ok('doubaoUsage 坏 JSON → null', doubaoUsage('{oops') === null);
      ok('doubaoUsage 非对象 → null', doubaoUsage(42) === null);
      ok('doubaoUsage 字符串数字接受', doubaoUsage({ system_prompt: '4000', messages: 12000, skills: '800', tools: 200 }).input === 17000);

      const tree = stateTree({ m1: { extra: extra() } });
      const evs = doubaoEvents(tree, 'doubao');
      ok('doubaoEvents 单消息成事件', evs.length === 1);
      const e = evs[0];
      ok('doubaoEvents 字段口径', e.ts === 1.7e12 && e.model === 'doubao-model-38' && e.session_id === 'conv-a'
        && e.project === 'dashboard' && e.input_tokens === 17000 && e.output_tokens === 0 && e.cached_input === 0
        && e.cache_write === 0 && e.reasoning_tokens === 0 && e.total_tokens === 17000);
      ok('doubaoEvents 去重键', e.dedup_key === 'doubao:conv-a:msg-1');

      const multi = stateTree({ m1: { extra: extra({ message_id: 'msg-1', create_time_ms: 1.7e12 }) },
        m2: { extra: extra({ message_id: 'msg-2', create_time_ms: 1.7e12 + 5000, conversation_id: 'conv-a' }) } });
      ok('doubaoEvents 一任务多轮多条', doubaoEvents(multi, 'doubao').length === 2);

      const noTime = stateTree({ m1: { extra: extra({ create_time_ms: undefined }) } });
      ok('doubaoEvents 无时间跳过', doubaoEvents(noTime, 'doubao').length === 0);

      const numModel = stateTree({ m1: { extra: extra({ model_id: 38 }) } });
      ok('doubaoEvents 数字 model_id 记 doubao-model-<id>', doubaoEvents(numModel, 'doubao')[0].model === 'doubao-model-38');
      const strModel = stateTree({ m1: { extra: extra({ model_id: 'Doubao-Pro' }) } });
      ok('doubaoEvents 非数字 model 走 normalizeModel', doubaoEvents(strModel, 'doubao')[0].model === 'doubao-pro');

      const taskParam = stateTree({ m1: { extra: extra({ workspace: undefined, agent_task_param: '{"workspace":"/tmp/xyz/agent-run","x":1}' }) } });
      ok('doubaoEvents project 从 *_task_param JSON 取', doubaoEvents(taskParam, 'doubao')[0].project === 'agent-run');

      const noMsg = stateTree({ m1: { extra: extra({ message_id: undefined }) } });
      ok('doubaoEvents 缺 message_id 用摘要兜底且去重键仍成', doubaoEvents(noMsg, 'doubao')[0].dedup_key.startsWith('doubao:conv-a:'));

      const noUsage = stateTree({ m1: { extra: extra({ context_window_usage: '{"system_prompt":0,"messages":0}' }) } });
      ok('doubaoEvents 零用量不算', doubaoEvents(noUsage, 'doubao').length === 0);

      const convFallback = stateTree({ m1: { extra: extra({ conversation_id: undefined }) } });
      ok('doubaoEvents 缺会话用 identity 兜底', doubaoEvents(convFallback, 'doubao')[0].session_id === 'msg-1');
    }

    /* ---------- collectDoubaoFile 真实链路 ---------- */
    {
      const ldbDir = join(dir, 'fixture', 'chrome_doubao-chat_0.indexeddb.leveldb');
      mkdirSync(ldbDir, { recursive: true });
      const t1 = stateTree({ m1: { extra: extra({ message_id: 'msg-ldb' }) } });
      const t2 = stateTree({ m1: { extra: extra({ message_id: 'msg-ldb2', create_time_ms: 1.7e12 + 1000, conversation_id: 'conv-ldb' }) } });
      const table = ldbTable([[blockPayload([[Buffer.from('a'), inlineValue(new Ssv().obj([['t', t1]]))]]), 1],
        [blockPayload([[Buffer.from('b'), envelopeValue(new Ssv().obj([['t', t2]]))]]), 0]]);
      const ldbPath = join(ldbDir, '000001.ldb');
      writeFileSync(ldbPath, table);

      // WAL：跨块分片 + 外置值 + 无关值
      const w1 = stateTree({ m1: { extra: extra({ message_id: 'msg-wal', create_time_ms: 1.7e12 + 2000, conversation_id: 'conv-wal' }) } });
      const batch = writeBatch([
        [Buffer.from('wk'), inlineValue(new Ssv().obj([['t', w1]]))],
        [Buffer.from('ext'), externalValue()],
        [Buffer.from('nousage'), inlineValue(new Ssv().obj([['t', { state: {} }]]))],
      ]);
      const walPath = join(ldbDir, '000002.log');
      writeFileSync(walPath, walFile(batch));

      const blobDir = join(dir, 'fixture', 'chrome_doubao-chat_0.indexeddb.blob', '5', '00', '2');
      mkdirSync(blobDir, { recursive: true });
      const b1 = stateTree({ m1: { extra: extra({ message_id: 'msg-blob', create_time_ms: 1.7e12 + 3000, conversation_id: 'conv-blob' }) } });
      const blobPath = join(blobDir, '00000001');
      writeFileSync(blobPath, blobValue(new Ssv().obj([['t', b1]])));

      // 无关目录（不是 *.indexeddb.leveldb 后缀）不产生文件行，但直接调用也应无害
      mkdirSync(join(dir, 'fixture', 'other-leveldb'), { recursive: true });
      writeFileSync(join(dir, 'fixture', 'other-leveldb', 'x.ldb'), Buffer.alloc(64));
      ok('doubaoFileKind 判别', doubaoFileKind(ldbPath) === 'ldb' && doubaoFileKind(walPath) === 'log'
        && doubaoFileKind(blobPath) === 'blob' && doubaoFileKind('/tmp/x.txt') === null);

      const r1 = await collect(ldbPath);
      const r2 = await collect(walPath);
      const r3 = await collect(blobPath);
      ok('collect 三文件插入计数（ldb 2 条 + wal 1 条 + blob 1 条）', r1.inserted === 2 && r2.inserted === 1 && r3.inserted === 1, `r1=${r1.inserted} r2=${r2.inserted} r3=${r3.inserted}`);
      ok('collect 外置/无用量值不插', countByTool('doubao') === 4, `total=${countByTool('doubao')}`);
      ok('collect ldb+wal+blob 事件落库', ev('doubao:conv-ldb:msg-ldb2').total_tokens === 17000
        && ev('doubao:conv-wal:msg-wal').total_tokens === 17000 && ev('doubao:conv-blob:msg-blob').total_tokens === 17000);
      ok('collect ldb 事件', ev('doubao:conv-a:msg-ldb').project === 'dashboard');

      const again = await collect(ldbPath); await collect(walPath); await collect(blobPath);
      ok('collect 重扫幂等（dedup 收成一条）', again.inserted === 0 && countByTool('doubao') === 4, `again=${again.inserted} total=${countByTool('doubao')}`);

      // 畸形输入：坏 magic 表、坏日志、坏 blob → 静默跳过不抛
      const badLdb = join(ldbDir, '000003.ldb'); writeFileSync(badLdb, Buffer.alloc(64));
      const badLog = join(ldbDir, '000004.log'); writeFileSync(badLog, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00]));
      const badBlob = join(blobDir, '00000002'); writeFileSync(badBlob, Buffer.from([0xff, 0x11, 0x02, 0x01]));
      let threw = false;
      try { await collect(badLdb); await collect(badLog); await collect(badBlob); } catch { threw = true; }
      ok('collect 畸形输入静默跳过', !threw && countByTool('doubao') === 4, `threw=${threw} total=${countByTool('doubao')}`);
      const badSsv = join(ldbDir, '000005.ldb');
      writeFileSync(badSsv, ldbTable([[blockPayload([[Buffer.from('k'), Buffer.concat([vi(1), Buffer.from([0xff, 0x0f]), Buffer.from('context_window_usage'), Buffer.from([0x77])])]]), 0]]));
      const r4 = await collect(badSsv);
      ok('collect 未知 SSV 标签计 undecodable 不抛', r4.undecodable === 1 && !threw);

      // 写入中的 .ldb（无 magic）视为空
      const midWrite = join(ldbDir, '000006.ldb'); writeFileSync(midWrite, Buffer.alloc(48));
      const r5 = await collect(midWrite);
      ok('collect 写入中的 ldb（无 magic）跳过', r5.inserted === 0);
    }

    /* ---------- Scanner 真实链路幂等重扫 ---------- */
    {
      const originals = SOURCES.slice();
      try {
        SOURCES.splice(0, SOURCES.length, {
          tool: 'doubaowork', label: '豆包工作', collector: 'doubao', version: 1, kind: 'leveldb',
          roots: [join(dir, 'fixture')],
        });
        const scanner = new Scanner(store);
        await scanner.scanAll({ quiet: true });
        const first = store.byTool().reduce((a, r) => a + r.total, 0);
        await scanner.scanAll({ quiet: true });
        ok('Scanner 重扫幂等', store.byTool().reduce((a, r) => a + r.total, 0) === first);
      } finally { SOURCES.splice(0, SOURCES.length, ...originals); }
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

/**
 * 端到端 fixture：在 <home>/Library/Application Support/{Doubao,DoubaoWork}/Default/IndexedDB
 * 下写出与真实布局一致的 leveldb 树（raw/snappy .ldb、跨 32KB .log、.blob 外置值、
 * ff 11 01 外置干扰、无关 leveldb 目录）。run.mjs 第 3 层经真实 config SOURCES + CLI scan
 * 走完整链路后，用返回的黄金数字断言。
 * 返回 { gold, rewriteFiles }：gold[<tool>] = { n, total, model, projects, dedup }；
 * rewriteFiles 为字节相同重写系列（改 mtime 触发重扫，dedup 应保持幂等）。
 */
export function writeDoubaoE2eFixture(home) {
  const gold = {};
  const rewriteFiles = [];
  const usages = { system_prompt: 4000, messages: 12000, skills: 800, tools: 200, total_window_size: 256000 };
  for (const [tool, app] of [['doubao', 'Doubao'], ['doubaowork', 'DoubaoWork']]) {
    const root = join(home, 'Library', 'Application Support', app, 'Default', 'IndexedDB');
    const ldbDir = join(root, 'chrome_doubao-chat_0.indexeddb.leveldb');
    mkdirSync(ldbDir, { recursive: true });
    const mk = (mid, cid, off) => stateTree({ m1: { extra: extra({
      context_window_usage: JSON.stringify(usages), message_id: mid, conversation_id: cid, create_time_ms: 1.7e12 + off,
    }) } });
    const v = (tree) => inlineValue(new Ssv().obj([['t', tree]]));
    const ev = (tree) => envelopeValue(new Ssv().obj([['t', tree]]));
    const ldbPath = join(ldbDir, '000001.ldb');
    writeFileSync(ldbPath, ldbTable([
      [blockPayload([[Buffer.from('a'), v(mk(`msg-${tool}-ldb1`, `e2e-${tool}-ldb`, 1000))]]), 1],
      [blockPayload([[Buffer.from('b'), ev(mk(`msg-${tool}-ldb2`, `e2e-${tool}-ldb`, 2000))]]), 0],
      [blockPayload([[Buffer.from('ext'), externalValue()]]), 0], // ff 11 01 外置干扰
    ]));
    // 跨 32KB .log：batch > 32768-7，FIRST 填满块 0，LAST 落块 1；外置干扰值一并写入
    const walPath = join(ldbDir, '000123.log');
    const batch = writeBatch([
      [Buffer.from('wk'), v(mk(`msg-${tool}-wal`, `e2e-${tool}-wal`, 3000))],
      [Buffer.from('ext'), externalValue()],
      [Buffer.from('pad'), Buffer.alloc(WAL_BLOCK - 200, 0x61)], // 撑到跨块
    ]);
    writeFileSync(walPath, walFile(batch));
    const blobPath = join(root, 'chrome_doubao-chat_0.indexeddb.blob', '5', '00', '2', '00000001');
    mkdirSync(dirname(blobPath), { recursive: true });
    writeFileSync(blobPath, blobValue(new Ssv().obj([['t', mk(`msg-${tool}-blob`, `e2e-${tool}-blob`, 4000)]])));
    // 无关 leveldb 目录（dirname 不以 .indexeddb.leveldb 结尾）：scanner 必须忽略
    const otherDir = join(root, 'other-leveldb');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, '000001.ldb'), Buffer.alloc(64));
    rewriteFiles.push(ldbPath, walPath, blobPath);
    gold[tool] = {
      n: 4, total: 68000,
      model: 'doubao-model-38',
      projects: ['dashboard'],
      dedup: [`${tool}:e2e-${tool}-ldb:msg-${tool}-ldb1`, `${tool}:e2e-${tool}-ldb:msg-${tool}-ldb2`,
        `${tool}:e2e-${tool}-wal:msg-${tool}-wal`, `${tool}:e2e-${tool}-blob:msg-${tool}-blob`],
    };
  }
  return { gold, rewriteFiles };
}
