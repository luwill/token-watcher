import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { SOURCES } from '../src/config.js';
import { buildSummary } from '../src/server.js';
import { buildLeaderboardReport } from '../src/leaderboard.js';

export async function testDateRanges(ok) {
  console.log('\n[ranges] 自然日与压缩历史完整性');
  const root = mkdtempSync(join(tmpdir(), 'tw-ranges-'));
  const originalRoots = SOURCES.map(source => source.roots);
  const stores = [];
  const makeStore = name => {
    const store = new Store(join(root, `${name}.db`));
    stores.push(store);
    return store;
  };
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); }
    catch (err) { ok(name, false, err.stack); }
  };
  const sum = rows => rows.reduce((total, row) => total + row.total, 0);
  try {
    for (const [tz, current, week, month] of [
      ['Asia/Taipei', '2026-10-10T21:00:00+08:00', '2026-10-04T00:00:00+08:00', '2026-09-11T00:00:00+08:00'],
      ['UTC', '2026-10-10T21:00:00Z', '2026-10-04T00:00:00Z', '2026-09-11T00:00:00Z'],
      ['America/New_York', '2026-03-10T12:00:00-04:00', '2026-03-04T00:00:00-05:00', '2026-02-09T00:00:00-05:00'],
      ['America/New_York', '2026-11-03T12:00:00-05:00', '2026-10-28T00:00:00-04:00', '2026-10-05T00:00:00-04:00'],
    ]) {
      await check(`${tz} ${current.slice(0, 10)}：含今天的自然日边界（含夏令时切换）`, () => {
        const script = `
          import assert from 'node:assert/strict';
          import { localRangeStart } from ${JSON.stringify(new URL('../src/timeRange.js', import.meta.url).href)};
          const now = Date.parse(${JSON.stringify(current)});
          assert.equal(localRangeStart(7, now), Date.parse(${JSON.stringify(week)}));
          assert.equal(localRangeStart(30, now), Date.parse(${JSON.stringify(month)}));
          assert.equal(localRangeStart(0, now), 0);
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
      });
    }

    await check('本地 7 天卡片、图表与费用同窗，30 天边界含起点且排除前一毫秒', async () => {
      const store = makeStore('calendar');
      const now = new Date(2026, 9, 10, 21).getTime();
      const week = new Date(2026, 9, 4).getTime();
      const month = new Date(2026, 8, 11).getTime();
      for (const [ts, total] of [[month - 1, 5], [month, 10], [week - 1, 20], [week, 40], [now - 1, 80]]) {
        store.insertEvent({ ts, tool: 'codex', model: 'kimi-k3', input_tokens: total,
          total_tokens: total, dedup_key: `calendar:${ts}` });
      }
      const seven = await buildSummary(store, {}, 7, { now });
      assert.equal(seven.totals.last7d_tokens, 120);
      assert.equal(sum(seven.by_day), 120);
      assert.equal(seven.by_day[0].day, '2026-10-04');
      assert(seven.costs.last7d_cny > 0);
      assert(Math.abs(seven.costs.last7d_cny - sum(seven.costs.by_day)) < 1e-10);
      const thirty = await buildSummary(store, {}, 30, { now });
      assert.equal(sum(thirty.by_day), 150);
      assert.equal(thirty.by_day[0].day, '2026-09-11');
      assert.equal(thirty.totals.all_time_tokens, 155);
      assert.equal(sum((await buildSummary(store, {}, 0, { now })).by_day), 155);
    });

    await check('Hermes 跨午夜后保留首日 1000，次日只计新增 500，重放幂等', async () => {
      const store = makeStore('hermes-days');
      const midnight = new Date(2026, 10, 18).getTime();
      const first = {
        tool: 'hermes', session_id: 'overnight', model: 'kimi-k3', project: 'fixture',
        dedup_key: 'hermes:smu:0123456789abcdef0123', ts: midnight - 1,
        input_tokens: 600, cached_input: 200, cache_write: 100, output_tokens: 100,
        reasoning_tokens: 40, total_tokens: 1000,
      };
      const replay = snapshot => {
        const stage = store.stageWrites({ device: 'windows' });
        stage.store.upsertHermesEvent(snapshot);
        return stage.replay();
      };
      // The previous collector stored a single, unsuffixed cumulative event.
      const seed = store.stageWrites({ device: 'windows' });
      seed.store.insertEvent(first);
      seed.replay();
      assert.equal(replay(first), 0);
      const next = { ...first, ts: midnight, input_tokens: 800, total_tokens: 1200 };
      assert.equal(replay(next), 1);
      const final = { ...next, ts: midnight + 1000, cached_input: 350, cache_write: 150,
        output_tokens: 200, reasoning_tokens: 60, total_tokens: 1500 };
      assert.equal(replay(final), 0);
      assert.equal(replay(final), 0); // collector lookback
      assert.equal(replay(next), 0); // an older staged scan finishes later
      assert.equal(replay({ ...next, ts: final.ts }), 0); // same millisecond, smaller counters
      assert.equal(replay({ ...final, ts: new Date(2026, 10, 19).getTime() }), 0);

      const summary = await buildSummary(store, {}, 2, { now: midnight + 2000, device: 'windows' });
      assert.deepEqual(summary.by_day_all, [
        { d: '2026-11-17', total: 1000 }, { d: '2026-11-18', total: 500 },
      ]);
      assert.equal(summary.totals.today_tokens, 500);
      assert.equal(summary.totals.all_time_tokens, 1500);
      assert.equal(summary.totals.all_time_events, 2);
      const secondDay = store.db.prepare(`SELECT input_tokens, cached_input, cache_write,
        output_tokens, reasoning_tokens FROM events WHERE ts >= ?`).get(midnight);
      assert.deepEqual({ ...secondDay }, { input_tokens: 200, cached_input: 150, cache_write: 50,
        output_tokens: 100, reasoning_tokens: 20 });
    });

    await check('排行榜上报按含今天的 UTC 7/30 自然日聚合，用量及主力模型不混入前一天', async () => {
      const store = makeStore('utc');
      const now = Date.parse('2026-10-10T13:00:00Z');
      const add = (iso, model, total) => store.insertEvent({ ts: Date.parse(iso), tool: 'codex',
        model, total_tokens: total, dedup_key: `utc:${iso}` });
      add('2026-09-10T23:59:59.999Z', 'expired-month', 1_000_000);
      add('2026-09-11T00:00:00Z', 'month-model', 500);
      add('2026-10-03T23:59:59.999Z', 'expired-week', 50);
      add('2026-10-04T00:00:00Z', 'week-model', 200);
      add('2026-10-10T00:00:00Z', 'today-model', 100);
      add('2026-10-10T13:00:00.001Z', 'future', 1_000_000);
      const report = await buildLeaderboardReport(store, { now, roiFn: async () => ({ configured: false }) });
      assert.equal(report.day_tokens, 100);
      assert.equal(report.week_tokens, 300);
      assert.equal(report.month_tokens, 850);
      assert.deepEqual(report.models_by_period.day, [['today-model', 100]]);
      assert.deepEqual(report.models_by_period.week, [['week-model', 67]]);
      assert.deepEqual(report.models_by_period.month, [['month-model', 59]]);
    });

    const zstdBin = ['zstd', '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd']
      .find(bin => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0);
    if (typeof zlib.zstdCompressSync !== 'function' && !zstdBin) {
      console.log('  – 跳过压缩历史窗口集成（无 zstd CLI 或 Node 内置 zstd）');
      return;
    }
    await check('恢复窗口内压缩历史：7 天保持不变、30 天补齐且复扫幂等', async () => {
      const sessions = join(root, 'sessions'); mkdirSync(sessions);
      SOURCES.forEach(source => { source.roots = []; });
      SOURCES.find(source => source.tool === 'codex').roots = [sessions];
      const store = makeStore('history');
      const scanner = new Scanner(store);
      const now = new Date(2026, 9, 10, 21).getTime();
      const rollout = (month, day, total, compressed = false) => {
        const ts = new Date(2026, month - 1, day).getTime();
        const stem = `rollout-2026-${month}-${day}-range`;
        const line = (delta, type, payload) => JSON.stringify({ timestamp: new Date(ts + delta).toISOString(), type, payload });
        const usage = { input_tokens: total, output_tokens: 0, total_tokens: total };
        const text = [
          line(-2000, 'session_meta', { id: stem, cwd: '/synthetic/range' }),
          line(-1000, 'turn_context', { model: 'kimi-k3' }),
          line(0, 'event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } }),
        ].join('\n') + '\n';
        let content = text;
        if (compressed) {
          if (typeof zlib.zstdCompressSync === 'function') content = zlib.zstdCompressSync(Buffer.from(text));
          else {
            const result = spawnSync(zstdBin, ['-q', '-c'], { input: text });
            assert.equal(result.status, 0, result.stderr?.toString());
            content = result.stdout;
          }
        }
        writeFileSync(join(sessions, `${stem}.jsonl${compressed ? '.zst' : ''}`), content);
      };
      rollout(10, 3, 80); rollout(10, 4, 160); rollout(10, 10, 320);
      await scanner.scanAll({ quiet: true });
      assert.equal(sum((await buildSummary(store, scanner.stats, 7, { now })).by_day), 480);
      assert.equal(sum((await buildSummary(store, scanner.stats, 30, { now })).by_day), 560);
      rollout(9, 10, 5, true); // 30 天以外仍应计入总历史。
      rollout(9, 11, 10, true); rollout(9, 20, 20, true); rollout(9, 27, 40, true);
      for (let round = 0; round < 2; round++) {
        await scanner.scanAll({ quiet: true });
        assert.equal(scanner.stats.codex.parse_errors, 0);
        const seven = await buildSummary(store, scanner.stats, 7, { now });
        const thirty = await buildSummary(store, scanner.stats, 30, { now });
        assert.equal(seven.totals.last7d_tokens, 480);
        assert.equal(sum(seven.by_day), 480);
        assert.equal(sum(thirty.by_day), 630);
        assert.equal(thirty.totals.all_time_tokens, 635);
        assert.equal(thirty.totals.all_time_events, 7);
        assert.equal(thirty.totals.active_days, 7);
      }
    });
  } finally {
    SOURCES.forEach((source, i) => { source.roots = originalRoots[i]; });
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
