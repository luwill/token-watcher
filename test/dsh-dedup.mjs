/** One DSH request can appear as a chunk, a message and a v3 snapshot copy. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { SOURCES } from '../src/config.js';
import { collectDshFile } from '../src/collectors/dsh.js';

const T = Date.parse('2026-09-01T10:00:00Z');
const usage = { inputTokens: 100, cacheReadTokens: 850, cacheWriteTokens: 50,
  outputTokens: 100, reasoningTokens: 20, totalTokens: 1100 };
const chunk = (seq = 10, turn = 1, step = 1, u = usage) => ({
  type: 'assistant/chunk', seq, time: T,
  data: { turn, step, chunk: { type: 'usage', usage: u } },
});
const message = (seq = 11, turn = 1, step = 1, u = usage) => ({
  type: 'assistant/message', seq, time: T + 1,
  data: { turn, step, usage: u, message: { source: { model: 'Dsh-Final-Model' } } },
});
const rows = store => store.db.prepare("SELECT * FROM events WHERE tool = 'dsh' ORDER BY dedup_key").all();
const total = store => rows(store).reduce((sum, e) => sum + e.total_tokens, 0);
const legacyKey = (rec, file, id = 'session-a') => rec.type === 'assistant/chunk'
  ? `dsh:${id}:${rec.seq}:${rec.data.turn ?? ''}:${rec.data.step ?? ''}`
  : `dsh:${id}:${file}:${rec.seq}`;
const seedLegacy = (store, rec, file, id = 'session-a') => {
  const u = rec.data.usage ?? rec.data.chunk.usage;
  store.insertEvent({ ts: rec.time, tool: 'dsh', session_id: id, model: 'dsh-header-model',
    input_tokens: u.inputTokens, cached_input: u.cacheReadTokens, cache_write: u.cacheWriteTokens,
    output_tokens: u.outputTokens, reasoning_tokens: u.reasoningTokens,
    total_tokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens,
    dedup_key: legacyKey(rec, file, id) });
};

export async function testDshDedup(ok) {
  console.log('\n[dsh] 按请求去重与旧数据迁移');
  const bins = ['zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd'];
  const bin = bins.find(b => spawnSync(b, ['--version']).status === 0);
  if (!bin && typeof zlib.zstdCompressSync !== 'function') {
    console.log('  – 跳过（无 zstd CLI 或内置压缩，无法构造夹具）');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'tw-dsh-dedup-'));
  const stores = [];
  const makeStore = () => { const st = new Store(join(root, `${stores.length}.db`)); stores.push(st); return st; };
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); }
    catch (err) { ok(name, false, err.stack); }
  };
  let n = 0;
  // Use concatenated frames when the CLI is available, as DSH does in production.
  const fixture = (name, records, dir = join(root, `f${n++}`, 'session-a')) => {
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'session', cwd: '/work/example' },
      { type: 'request/header', data: { header: { config: { model: 'Dsh-Header-Model' } } } },
      ...records,
    ].map(r => JSON.stringify(r) + '\n');
    const compress = text => {
      if (typeof zlib.zstdCompressSync === 'function') return zlib.zstdCompressSync(Buffer.from(text));
      const r = spawnSync(bin, ['-q', '-c'], { input: text });
      assert.equal(r.status, 0, r.stderr?.toString());
      return r.stdout;
    };
    const path = join(dir, name);
    writeFileSync(path, bin ? Buffer.concat(lines.map(compress)) : compress(lines.join('')));
    return path;
  };
  const scan = (store, path, fileId = 'session-a') => collectDshFile(store, { path, fileId });
  const oldName = 'session.jsonl.zstd', v3Name = 'session.v3.jsonl.zstd';
  try {
    await check('chunk + message 的时间差 1ms，仍只算一次请求；reasoning 不再加一次', async () => {
      const store = makeStore();
      const path = fixture(oldName, [chunk(), message()]);
      assert.equal((await scan(store, path)).inserted, 1);
      assert.equal(total(store), 1100);
      const [e] = rows(store);
      assert.equal(e.reasoning_tokens, 20);
      assert.equal(e.model, 'dsh-final-model');
      assert.equal(e.project, 'example');
      assert.equal((await scan(store, path)).inserted, 0);
      assert.equal(rows(store).length, 1);
    });

    for (const reverse of [false, true]) {
      await check(`新旧快照${reverse ? '倒序' : '正序'}扫描：重叠只算一次，独有历史与相撞的 seq 都保留`, async () => {
        const store = makeStore();
        const paths = [fixture(oldName, [chunk(), message(), message(20, 1, 2)]),
          fixture(v3Name, [message(10), message(20, 2, 1)])];
        if (reverse) paths.reverse();
        for (const path of paths) await scan(store, path);
        assert.equal(rows(store).length, 3);
        assert.equal(total(store), 3300);
        for (const path of paths) assert.equal((await scan(store, path)).inserted, 0);
        await scan(store, fixture(oldName, [chunk()])); // stale, shorter snapshot
        assert.equal(total(store), 3300);
      });
    }

    await check('相同时间/用量的不同请求、不同会话不合并；turn/step=0 有效', async () => {
      const store = makeStore();
      const path = fixture(v3Name, [message(1, 0, 0), message(2, 0, 1), message(3, 1, 0)]);
      await scan(store, path);
      await scan(store, path, 'session-b');
      assert.equal(rows(store).length, 6);
      assert.equal(total(store), 6600);
    });

    for (const reverse of [false, true]) {
      await check(`存量迁移${reverse ? '倒序' : '正序'}：3 行归为 1 行，只删除原始文件证实的旧键`, async () => {
        const store = makeStore();
        const records = [[oldName, [chunk(), message()]], [v3Name, [message(3)]]];
        for (const [name, recs] of records) for (const rec of recs) seedLegacy(store, rec, name);
        seedLegacy(store, message(99, 99), oldName); // source record no longer available
        seedLegacy(store, message(), oldName, 'session-a-sibling');
        store.insertEvent({ tool: 'other', ts: T, total_tokens: 777, dedup_key: 'other:keep' });
        assert.equal(total(store), 5500);
        if (reverse) records.reverse();
        for (const [name, recs] of records) await scan(store, fixture(name, recs));
        assert.equal(rows(store).length, 3);
        assert.equal(total(store), 3300);
        assert.ok(rows(store).some(e => e.dedup_key === legacyKey(message(99, 99), oldName)));
        assert.equal(store.db.prepare("SELECT total_tokens t FROM events WHERE tool = 'other'").get().t, 777);
        for (const [name, recs] of records) assert.equal((await scan(store, fixture(name, recs))).inserted, 0);
        assert.equal(total(store), 3300);
      });
    }

    for (const reverse of [false, true]) {
      await check(`同一 turn/step 但输入用量不同的是两次请求（如失败后重试）：${reverse ? '倒序' : '正序'}扫描都各算一次`, async () => {
        const store = makeStore();
        const retry = { ...usage, inputTokens: 300, totalTokens: 1300 };
        // 两份快照里的 seq 与先后顺序都不同：去重键只能取决于记录自身
        const paths = [fixture(oldName, [chunk(), message(), message(12, 1, 1, retry)]),
          fixture(v3Name, [message(5, 1, 1, retry), message(6)])];
        if (reverse) paths.reverse();
        for (const path of paths) await scan(store, path);
        assert.deepEqual(rows(store).map(e => e.total_tokens).sort(), [1100, 1300]);
        for (const path of paths) assert.equal((await scan(store, path)).inserted, 0);
        assert.equal(total(store), 2400);
      });
    }

    await check('PR #1 分支存下的请求键（不含输入用量）升级后被替换，不重复计数', async () => {
      const store = makeStore();
      store.insertEvent({ ts: T + 1, tool: 'dsh', session_id: 'session-a', model: 'dsh-final-model',
        input_tokens: 100, cached_input: 850, cache_write: 50, output_tokens: 100, total_tokens: 1100,
        dedup_key: 'dsh:request:session-a:1:1' });
      store.insertEvent({ ts: T, tool: 'dsh', session_id: 'session-a', input_tokens: 1, total_tokens: 1,
        dedup_key: 'dsh:request:session-a:1:10' }); // 键只是前缀相同
      await scan(store, fixture(v3Name, [message()]));
      assert.deepEqual(rows(store).map(e => e.total_tokens).sort((a, b) => a - b), [1, 1100]);
    });

    await check('先读流式用量、后读完整消息时补齐；旧副本不回退用量', async () => {
      const store = makeStore();
      const partial = fixture(oldName, [chunk(10, 1, 1, { ...usage, outputTokens: 0 })]);
      await scan(store, partial);
      assert.equal(total(store), 1000);
      await scan(store, fixture(oldName, [chunk(), message()]));
      assert.equal(total(store), 1100);
      await scan(store, partial);
      assert.equal(total(store), 1100);
      assert.equal(rows(store).length, 1);
    });

    await check('缺少或非法 turn/step 时保持旧键，不猜测合并历史事件', async () => {
      const store = makeStore();
      const recs = [chunk(1, null, null), message(2, null, null), message(3, 1, null),
        message(4, '1', 1), message(5, -1, 1), message(6, 1, 1.5)];
      for (const rec of recs) seedLegacy(store, rec, oldName);
      await scan(store, fixture(oldName, recs));
      assert.deepEqual(rows(store).map(e => e.dedup_key).sort(), recs.map(r => legacyKey(r, oldName)).sort());
      assert.equal(total(store), recs.length * 1100);
    });

    await check('升采集版本后 mtime/size 未变也重扫；失败回滚旧行与游标，重试可恢复', async () => {
      const source = SOURCES.find(s => s.tool === 'dsh');
      assert.ok(source.version > 3, 'DSH collector version must invalidate v3 file cursors');
      const store = makeStore();
      const dir = join(root, 'scanner', 'session-a');
      const recs = [chunk(), message(), message(30, 1, 2)];
      const path = fixture(oldName, recs, dir);
      for (const rec of recs) seedLegacy(store, rec, oldName);
      const s = statSync(path);
      store.saveFile({ path, tool: 'dsh', session_id: basename(dir), size: s.size,
        mtime_ms: s.mtimeMs, offset: 0, state_json: '{"_v":3}' });
      const savedSources = [...SOURCES];
      SOURCES.splice(0, SOURCES.length, { ...source, roots: [dir] });
      const originalInsert = store.insertEvent;
      let calls = 0;
      try {
        store.insertEvent = function (e) {
          if (++calls === 2) throw new Error('injected write failure');
          return originalInsert.call(this, e);
        };
        const scanner = new Scanner(store);
        await scanner.scanAll();
        assert.equal(scanner.stats.dsh.parse_errors, 1);
        assert.equal(total(store), 3300);
        assert.equal(JSON.parse(store.getFile(path).state_json)._v, 3);
        store.insertEvent = originalInsert;
        await scanner.scanAll();
        assert.equal(scanner.stats.dsh.parse_errors, 0);
        assert.equal(total(store), 2200);
        assert.equal(rows(store).length, 2);
        assert.equal(JSON.parse(store.getFile(path).state_json)._v, source.version);
        assert.equal((await scanner.scanAll()).inserted, 0);
        writeFileSync(path, 'broken zstd');
        await scanner.scanAll();
        assert.equal(scanner.stats.dsh.parse_errors, 1);
        assert.equal(total(store), 2200);
      } finally {
        store.insertEvent = originalInsert;
        SOURCES.splice(0, SOURCES.length, ...savedSources);
      }
    });
  } finally {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
