/** Compressed Codex rollout snapshots and identity across copies. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { SOURCES } from '../src/config.js';
import { decompressZstd, decompressZstdLines } from '../src/zstd.js';

const stamp = n => new Date(Date.parse('2026-09-20T10:00:00Z') + n * 1000).toISOString();
const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached,
  cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0,
  total_tokens: input + output });
const meta = (stem, n = 0) => JSON.stringify({ timestamp: stamp(n), type: 'session_meta',
  payload: { id: stem, cwd: '/work/codex-zstd' } });
const model = n => JSON.stringify({ timestamp: stamp(n), type: 'event_msg', payload: {
  type: 'thread_settings_applied', thread_settings: { model: 'gpt-test' } } });
const token = (n, cumulative, last = cumulative) => JSON.stringify({ timestamp: stamp(n), type: 'event_msg', payload: {
  type: 'token_count', info: { total_token_usage: cumulative, last_token_usage: last } } });
const call = (id, n) => JSON.stringify({ timestamp: stamp(n), type: 'response_item', payload: {
  type: 'function_call', name: 'shell', call_id: id } });
const lines = (...records) => `${records.join('\n')}\n`;
const totalUsage = (...items) => items.reduce((a, b) => Object.fromEntries(
  Object.keys(a).map(k => [k, a[k] + b[k]])));
const zstdBin = ['zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd']
  .find(path => spawnSync(path, ['--version'], { stdio: 'ignore' }).status === 0);

function compress(text) {
  if (typeof zlib.zstdCompressSync === 'function') return zlib.zstdCompressSync(Buffer.from(text));
  assert(zstdBin, 'cannot build zstd fixture without Node zstd or zstd CLI');
  const r = spawnSync(zstdBin, ['-q', '-c'], { input: text });
  assert.equal(r.status, 0, r.stderr?.toString());
  return r.stdout;
}

function compressFrames(text) {
  const frame = line => {
    if (!zstdBin) return compress(`${line}\n`);
    const r = spawnSync(zstdBin, ['-q', '-c'], { input: `${line}\n` });
    assert.equal(r.status, 0, r.stderr?.toString());
    return r.stdout;
  };
  return Buffer.concat(text.trimEnd().split('\n').map(frame));
}

export async function testCodexZstd(ok) {
  console.log('\n[codex] zstd rollout 快照');
  const root = mkdtempSync(join(tmpdir(), 'tw-codex-zstd-'));
  const originalRoots = SOURCES.map(source => source.roots);
  let sessions = join(root, 'sessions');
  let archived = join(root, 'archived_sessions');
  mkdirSync(sessions, { recursive: true });
  mkdirSync(archived, { recursive: true });
  // Scanner is shared with the app config; point every source at an empty synthetic root so
  // these tests can never enumerate the user's real ~/.codex or other source directories.
  SOURCES.forEach(source => { source.roots = []; });
  const codex = SOURCES.find(source => source.tool === 'codex');
  codex.roots = [sessions, archived];
  const selectRoots = name => {
    sessions = join(root, `${name}-sessions`);
    archived = join(root, `${name}-archived`);
    mkdirSync(sessions, { recursive: true });
    mkdirSync(archived, { recursive: true });
    codex.roots = [sessions, archived];
  };
  const makeStore = name => new Store(join(root, `${name}.db`));
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); }
    catch (err) { ok(name, false, err.stack); }
  };
  const scan = async (store) => new Scanner(store).scanAll({ quiet: true });
  const events = store => store.db.prepare("SELECT * FROM events WHERE tool='codex' ORDER BY ts").all();
  const calls = store => store.db.prepare("SELECT * FROM tool_calls WHERE tool='codex'").all();
  const pathFor = (stem, ext = '.jsonl.zst', base = sessions) => {
    const path = join(base, '2026', '09', '20', `${stem}${ext}`);
    mkdirSync(dirname(path), { recursive: true });
    return path;
  };

  try {
    if (typeof zlib.zstdCompressSync !== 'function' && !zstdBin) {
      const sample = join(root, 'known-zstd-frame.zst');
      writeFileSync(sample, Buffer.from('KLUv/SAgAQEAc3ludGhldGljIHpzdGQgZmFsbGJhY2sgZml4dHVyZQo=', 'base64'));
      await check('无内置解压和 zstd CLI 时明确报错', async () => {
        await assert.rejects(decompressZstd(sample, { bins: [] }), /zstd 不可用/);
      });
      console.log('  – 跳过压缩集成夹具（无 zstd CLI 或 Node 内置 zstd，遵循 dsh 测试策略）');
      return;
    }
    selectRoots('fresh');
    await check('仅压缩日志首次扫描解出黄金 tokens、日期、模型和 session_id', async () => {
      const stem = 'rollout-2026-09-20T10-00-00-fixture';
      const first = usage(300, 80, 40), second = usage(500, 200, 70);
      const path = pathFor(stem);
      writeFileSync(path, compress(lines(meta(stem), model(1), token(2, first), token(4, totalUsage(first, second), second), call('gold-call', 5))));
      const store = makeStore('fresh');
      await scan(store);
      const got = events(store);
      assert.equal(got.length, 2);
      assert.equal(got.reduce((sum, e) => sum + e.total_tokens, 0), first.total_tokens + second.total_tokens);
      assert.deepEqual(got.map(e => [e.input_tokens, e.cached_input, e.output_tokens]), [[220, 80, 40], [300, 200, 70]]);
      assert(got.every(e => e.model === 'gpt-test' && e.session_id === stem));
      assert.deepEqual(got.map(e => new Date(e.ts).toISOString()), [stamp(2), stamp(4)]);
      assert.equal(calls(store).length, 1);
      store.close();
    });

    selectRoots('coexist');
    await check('普通与压缩副本及 .zstd 扩展共存，重复扫描保持 usage/tool_calls 幂等', async () => {
      const stem = 'rollout-2026-09-20T11-00-00-coexist';
      const a = usage(100, 20, 10), b = usage(200, 30, 20);
      const text = lines(meta(stem), model(1), token(2, a), token(4, totalUsage(a, b), b), call('same-call', 5));
      writeFileSync(pathFor(stem, '.jsonl'), text);
      writeFileSync(pathFor(stem, '.jsonl.zstd'), compress(text));
      writeFileSync(pathFor(stem, '.jsonl.zst', archived), zstdBin ? compressFrames(text) : compress(text));
      const store = makeStore('coexist');
      const scanner = new Scanner(store);
      await scanner.scanAll({ quiet: true });
      assert.equal(scanner.stats.codex.parse_errors, 0);
      assert.equal(events(store).length, 2);
      assert.equal(calls(store).length, 1);
      await scanner.scanAll({ quiet: true });
      assert.equal(scanner.stats.codex.parse_errors, 0);
      assert.equal(events(store).length, 2);
      assert.equal(calls(store).length, 1);
      store.close();
    });

    for (const shortFirst of [true, false]) {
      selectRoots(`order-${shortFirst}`);
      await check(`短长副本${shortFirst ? '先短后长' : '先长后短'}都保留完整历史`, async () => {
        const stem = `rollout-2026-09-20T12-00-0${shortFirst ? 1 : 2}-order`;
        const a = usage(100, 0, 10), b = usage(200, 20, 30);
        const short = lines(meta(stem), model(1), token(2, a));
        const full = lines(meta(stem), model(1), token(2, a), token(4, totalUsage(a, b), b));
        const shortPath = pathFor(stem, '.jsonl.zst');
        const fullPath = pathFor(stem, '.jsonl.zstd', archived);
        writeFileSync(shortPath, compress(short));
        writeFileSync(fullPath, compress(full));
        if (!shortFirst) { writeFileSync(shortPath, compress(full)); writeFileSync(fullPath, compress(short)); }
        const store = makeStore(`order-${shortFirst}`);
        await scan(store);
        assert.equal(events(store).length, 2);
        assert.equal(events(store).reduce((sum, e) => sum + e.total_tokens, 0), a.total_tokens + b.total_tokens);
        store.close();
      });
    }

    for (const shortFirst of [true, false]) {
      await check(`已有 v4 游标升级重扫时${shortFirst ? '先短后长' : '先长后短'}保留完整副本`, async () => {
        const stem = `rollout-2026-09-20T12-30-0${shortFirst ? 1 : 2}-upgrade`;
        const shortRoot = join(root, `upgrade-short-${shortFirst}`);
        const longRoot = join(root, `upgrade-long-${shortFirst}`);
        mkdirSync(shortRoot); mkdirSync(longRoot);
        const a = usage(120, 10, 15), b = usage(260, 40, 35);
        const shortText = lines(meta(stem), model(1), token(2, a));
        const fullText = lines(meta(stem), model(1), token(2, a), token(4, totalUsage(a, b), b), call('upgrade-call', 5));
        const shortPath = join(shortRoot, `${stem}.jsonl`);
        const fullPath = join(longRoot, `${stem}.jsonl.zst`);
        writeFileSync(shortPath, shortText);
        writeFileSync(fullPath, compress(fullText));
        codex.roots = shortFirst ? [shortRoot, longRoot] : [longRoot, shortRoot];
        const store = makeStore(`upgrade-${shortFirst}`);
        // Model an existing v4 database with both sibling cursors and the full historical rows.
        store.insertEvent({ ts: Date.parse(stamp(2)), tool: 'codex', session_id: stem,
          input_tokens: a.input_tokens - a.cached_input_tokens, cached_input: a.cached_input_tokens,
          output_tokens: a.output_tokens, total_tokens: a.total_tokens, dedup_key: `codex:file:${stem}:1` });
        store.insertEvent({ ts: Date.parse(stamp(4)), tool: 'codex', session_id: stem,
          input_tokens: b.input_tokens - b.cached_input_tokens, cached_input: b.cached_input_tokens,
          output_tokens: b.output_tokens, total_tokens: b.total_tokens, dedup_key: `codex:file:${stem}:2` });
        store.insertToolCall({ ts: Date.parse(stamp(5)), tool: 'codex', session_id: stem,
          name: 'shell', dedup_key: `codex:tc:file:${stem}:upgrade-call` });
        for (const path of [shortPath, fullPath]) {
          store.saveFile({ path, tool: 'codex', session_id: stem, size: 1, mtime_ms: 1,
            offset: 0, state_json: JSON.stringify({ _v: 4 }) });
        }
        await scan(store);
        assert.equal(events(store).length, 2);
        assert.equal(events(store).reduce((sum, e) => sum + e.total_tokens, 0), a.total_tokens + b.total_tokens);
        assert.equal(calls(store).length, 1);
        assert(store.db.prepare("SELECT state_json FROM files WHERE tool='codex'").all()
          .every(row => JSON.parse(row.state_json)._v === codex.version));
        store.close();
      });
    }
    codex.roots = [sessions, archived];

    selectRoots('snapshot');
    await check('压缩快照追加与重写按解压内容重扫，不把压缩字节数当游标', async () => {
      const stem = 'rollout-2026-09-20T13-00-00-snapshot';
      const a = usage(100, 10, 20), b = usage(300, 100, 50), replacement = usage(180, 30, 15);
      const path = pathFor(stem);
      const original = lines(meta(stem), model(1), token(2, a));
      writeFileSync(path, compress(original));
      const store = makeStore('snapshot');
      await scan(store);
      assert.equal(events(store).length, 1);
      // A second valid frame appends a complete JSONL record to the compressed snapshot.
      const added = lines(token(4, totalUsage(a, b), b));
      writeFileSync(path, zstdBin
        ? Buffer.concat([readFileSync(path), compress(added)])
        : compress(original + added));
      await scan(store);
      assert.equal(events(store).length, 2);
      assert.equal(events(store).reduce((sum, e) => sum + e.total_tokens, 0), a.total_tokens + b.total_tokens);
      writeFileSync(path, compress(lines(meta(stem), model(1), token(2, replacement))));
      utimesSync(path, new Date(), new Date(Date.now() + 2000));
      await scan(store);
      assert.equal(events(store).length, 1);
      assert.equal(events(store)[0].total_tokens, replacement.total_tokens);
      store.close();
    });

    selectRoots('rollback');
    await check('坏压缩事务回滚并保留原 events/files，parse_errors 可见', async () => {
      const stem = 'rollout-2026-09-20T14-00-00-corrupt';
      const a = usage(140, 40, 25), path = pathFor(stem);
      writeFileSync(path, compress(lines(meta(stem), model(1), token(2, a))));
      const store = makeStore('rollback');
      const scanner = new Scanner(store);
      await scanner.scanAll({ quiet: true });
      const beforeFile = store.getFile(path);
      const beforeEvents = events(store).map(e => [e.dedup_key, e.total_tokens]);
      writeFileSync(path, Buffer.from('not a zstd frame'));
      utimesSync(path, new Date(), new Date(Date.now() + 3000));
      await scanner.scanAll({ quiet: true });
      assert.equal(scanner.stats.codex.parse_errors, 1);
      assert.match(scanner.stats.codex.last_error, /zstd|decompress|帧|frame/i);
      assert.deepEqual(events(store).map(e => [e.dedup_key, e.total_tokens]), beforeEvents);
      assert.equal(store.getFile(path).size, beforeFile.size);
      assert.equal(store.getFile(path).mtime_ms, beforeFile.mtime_ms);
      store.close();
    });

    selectRoots('move');
    await check('普通 JSONL 迁移到压缩并移动到 archived 不重复计数', async () => {
      const stem = 'rollout-2026-09-20T15-00-00-moved';
      const a = usage(250, 50, 35), text = lines(meta(stem), model(1), token(2, a), call('move-call', 3));
      const plain = pathFor(stem, '.jsonl');
      writeFileSync(plain, text);
      const store = makeStore('move');
      await scan(store);
      assert.equal(events(store).length, 1);
      const archivePlain = pathFor(stem, '.jsonl', archived);
      renameSync(plain, archivePlain);
      writeFileSync(pathFor(stem), compress(text));
      await scan(store);
      assert.equal(events(store).length, 1);
      assert.equal(calls(store).length, 1);
      assert.equal(new Set(events(store).map(e => e.session_id)).size, 1);
      store.close();
    });

    selectRoots('plain-append');
    await check('JSONL 追加仍由普通字节游标正确续扫', async () => {
      const stem = 'rollout-2026-09-20T16-00-00-append';
      const a = usage(90, 10, 12), b = usage(190, 20, 22), path = pathFor(stem, '.jsonl');
      writeFileSync(path, lines(meta(stem), model(1), token(2, a)));
      const store = makeStore('plain-append');
      await scan(store);
      writeFileSync(path, lines(token(4, totalUsage(a, b), b)), { flag: 'a' });
      await scan(store);
      assert.equal(events(store).length, 2);
      assert.equal(events(store).reduce((sum, e) => sum + e.total_tokens, 0), a.total_tokens + b.total_tokens);
      store.close();
    });

    await check('Node 内置 zstd 单帧回落与外部 zstd 多帧解压完整', async () => {
      const content = lines(meta('fallback'), model(1));
      const single = pathFor('fallback');
      writeFileSync(single, compress(content));
      if (typeof zlib.zstdDecompressSync === 'function') {
        const fallback = await decompressZstd(single, { bins: ['/missing/zstd'] });
        assert.equal(fallback.toString(), content);
      } else {
        assert.match((await decompressZstd(single)).toString(), /fallback/);
      }
      const multi = pathFor('multi');
      writeFileSync(multi, compressFrames(content));
      if (zstdBin) assert.equal((await decompressZstd(multi)).toString(), content);
      await assert.rejects(decompressZstd(multi, { bins: [] }), /多个 zstd 帧|zstd 不可用/);
    });
  } finally {
    SOURCES.forEach((source, i) => { source.roots = originalRoots[i]; });
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 流式逐行解压（issue #12）：大归档解压后超 V8 字符串上限，codex 改走流式。
 * 行产出必须与旧的「整缓冲 + 整串循环」完全一致（含多字节、长行、尾部残行丢弃），
 * 坏档必须抛错（scanner 逐文件回滚的前提），无 CLI 时回落内置实现。
 */
export async function testZstdLines(ok) {
  console.log('\n[codex] zstd 流式逐行解压');
  const root = mkdtempSync(join(tmpdir(), 'tw-zstd-lines-'));
  try {
    // 多字节内容 + 超长行（跨 chunk）+ 尾部残行（无换行，应丢弃）
    const text = [
      JSON.stringify({ n: 1, p: '/工作目录/项目A' }),
      JSON.stringify({ n: 2, p: 'x'.repeat(70000) }),
      JSON.stringify({ n: 3, p: '尾行前' }),
      '{"partial": ',
    ].join('\n');
    const file = join(root, 's.jsonl.zst');
    writeFileSync(file, compress(text));

    // 等价基准：旧整串循环的切分结果
    const whole = (await decompressZstd(file)).toString('utf8');
    const expect = [];
    let s = 0, e;
    while ((e = whole.indexOf('\n', s)) !== -1) { expect.push(whole.slice(s, e)); s = e + 1; }

    if (zstdBin) {
      const got = [];
      for await (const line of decompressZstdLines(file, { bins: [zstdBin] })) got.push(line);
      ok('流式行序列与整串循环全等（多字节/长行/残行语义）',
        JSON.stringify(got) === JSON.stringify(expect), `${got.length} vs ${expect.length} 行`);

      // 截断的 zst：必须抛错，不能静默半档（scanner 靠异常触发逐文件回滚）
      const buf = readFileSync(file);
      const broken = join(root, 'broken.jsonl.zst');
      writeFileSync(broken, buf.subarray(0, Math.max(1, Math.floor(buf.length / 2))));
      let threw = null;
      try { for await (const l of decompressZstdLines(broken, { bins: [zstdBin] })) { void l; } }
      catch (err) { threw = err; }
      ok('截断的 zst 流式解压抛错（坏档案仍是单文件错误）', !!threw, String(threw).slice(0, 120));
    } else {
      console.log('  – 无 zstd CLI，流式直连断言跳过（内置回落路径仍验证）');
    }

    // 无 CLI：回落内置整缓冲实现，行语义一致
    if (typeof zlib.zstdDecompressSync === 'function') {
      const got = [];
      for await (const line of decompressZstdLines(file, { bins: [] })) got.push(line);
      ok('无 CLI 时回落内置实现，行序列一致', JSON.stringify(got) === JSON.stringify(expect));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
