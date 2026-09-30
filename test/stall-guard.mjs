/**
 * 睡眠唤醒后服务"活着但不工作"的防线。
 *
 * Node 的异步文件操作与域名解析（getaddrinfo）共用 libuv 线程池，默认 4 个线程。
 * 唤醒后网络未就绪，几个外网请求同时卡在解析里就能把池占满：扫描读不了目录、面板读不出页面，
 * 而进程空闲、CPU 为 0、端口照开——没有任何报错。请求的超时只是不再等结果，线程并不释放。
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const CLI = fileURLToPath(new URL('../bin/tokenwatcher.js', import.meta.url));
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

/**
 * 在临时 HOME 里起真实服务，监听后把线程池里的 n 个线程卡在没有写入方的命名管道上
 * （卡在系统调用里、CPU 为 0——与卡在域名解析里是同一种状态）。
 */
async function serveWithStuckThreads(root, n, extraEnv = {}) {
  const dir = mkdtempSync(join(root, 's-'));
  const fifos = Array.from({ length: n }, (_, i) => join(dir, `fifo${i}`));
  for (const f of fifos) execFileSync('mkfifo', [f]);
  const preload = join(dir, 'preload.mjs');
  writeFileSync(preload, `import { open } from 'node:fs';
const stick = () => { for (const f of ${JSON.stringify(fifos)}) open(f, 'r', () => {}); process.stderr.write('[sim] stuck\\n'); };
process.on('message', (m) => { if (m === 'stick') stick(); });`);
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', preload, CLI, 'serve', '--port', String(port), '--no-open'], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, TOKENMETER_OFFLINE: '1', TOKENMETER_NO_KEYCHAIN: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const until = async (re, ms) => {
    const end = Date.now() + ms;
    while (!re.test(out)) { if (Date.now() > end) throw new Error(`等不到 ${re}：\n${out}`); await new Promise(r => setTimeout(r, 50)); }
  };
  await until(/listening on/, 20_000);
  child.send('stick');
  await until(/\[sim\] stuck/, 5_000);
  return { child, port, exited, output: () => out, stop: () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } } };
}


export async function testStallGuard(ok) {
  console.log('\n[stall] 线程池被占满时的防线');
  const check = async (name, fn) => {
    try { await fn(); ok(name, true); }
    catch (err) { ok(name, false, err.stack); }
  };
  const { createDnsGate } = await import('../src/netGate.js');

  await check('解析一直不返回时，最多只有 2 个线程被占住，其余请求直接跳过', async () => {
    const stuck = []; // 收集回调但不调用 = 线程卡在 getaddrinfo 里
    const gate = createDnsGate({ lookupImpl: (host, cb) => { stuck.push([host, cb]); }, timeoutMs: 20 });
    const results = await Promise.all(['a.test', 'b.test', 'c.test', 'd.test', 'e.test'].map(h => gate.ready(h)));
    assert.deepEqual(results, [false, false, false, false, false]);
    assert.equal(stuck.length, 2, '只应发起 2 次真正的解析');
    // 超时不等于线程已释放：在系统调用返回之前，名额不能还回去
    assert.equal(await gate.ready('f.test'), false);
    assert.equal(stuck.length, 2);
    stuck[0][1](null, '203.0.113.1'); // 第一个终于返回
    assert.equal(await gate.ready('f.test'), false); // f.test 自己的解析仍未返回
    assert.equal(stuck.length, 3, '名额归还后才发起新的解析');
  });

  await check('网络正常时放行；IP 与本机地址不做解析', async () => {
    let calls = 0;
    const gate = createDnsGate({ lookupImpl: (host, cb) => { calls++; setImmediate(cb, null, '203.0.113.1'); } });
    assert.equal(await gate.ready('api.example.com'), true);
    assert.equal(await gate.ready('127.0.0.1'), true);
    assert.equal(await gate.ready('localhost'), true);
    assert.equal(await gate.ready('[::1]'), true);
    assert.equal(calls, 1);
  });

  await check('解析失败（断网）不放行，也不占名额', async () => {
    const gate = createDnsGate({ lookupImpl: (host, cb) => setImmediate(cb, Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })) });
    for (let i = 0; i < 5; i++) assert.equal(await gate.ready('api.example.com'), false);
  });

  await check('解析未就绪时不发请求，报出可读的原因', async () => {
    const gate = createDnsGate({ lookupImpl: () => {}, timeoutMs: 20 });
    let fetched = 0;
    const netFetch = gate.wrap(async () => { fetched++; return { ok: true }; });
    await assert.rejects(netFetch('https://api.example.com/v1/x'), /DNS/);
    assert.equal(fetched, 0);
    const okGate = createDnsGate({ lookupImpl: (h, cb) => setImmediate(cb, null, '203.0.113.1') });
    assert.deepEqual(await okGate.wrap(async (url, opts) => ({ url: String(url), opts }))('https://api.example.com/v1/x', { a: 1 }),
      { url: 'https://api.example.com/v1/x', opts: { a: 1 } });
  });

  const { createStallWatchdog } = await import('../src/watchdog.js');
  /** 可控探针：每次调用返回一个由测试决定何时完成的 Promise */
  const probes = () => {
    const open = [];
    return { probe: () => new Promise(r => open.push(r)), finish: () => open.shift()?.(), count: () => open.length };
  };

  await check('文件操作连续 N 次检查都没完成才判定卡死；中途完成就清零', async () => {
    const p = probes(); const stalls = [];
    const wd = createStallWatchdog({ probe: p.probe, stallTicks: 3, onStall: (why) => stalls.push(why) });
    wd.tick(); wd.tick(); // 探针挂起，已过 1 次检查
    p.finish(); await new Promise(setImmediate);
    wd.tick(); wd.tick(); wd.tick(); // 新探针挂起 2 次检查：还没到 3
    assert.equal(stalls.length, 0);
    wd.tick();
    assert.equal(stalls.length, 1);
    assert.match(stalls[0], /文件操作/);
    assert.equal(p.count(), 1, '探针未完成时不再叠加新的探针（不能自己把线程池占满）');
  });

  await check('睡眠唤醒（时钟一次跳过几小时）不算卡死：按检查次数计，不按挂钟时间计', async () => {
    const p = probes(); const stalls = [];
    const clock = Date.now;
    const wd = createStallWatchdog({ probe: p.probe, stallTicks: 3, onStall: (why) => stalls.push(why) });
    try {
      wd.tick();
      const t = clock(); Date.now = () => t + 8 * 3600_000; // 合盖 8 小时
      wd.tick();
      assert.equal(stalls.length, 0);
    } finally { Date.now = clock; }
  });

  await check('扫描一直在跑却没有进展（某个文件操作永不返回）同样判定卡死', async () => {
    const stalls = []; const scanner = { scanning: true, progress: 7 };
    const wd = createStallWatchdog({ probe: async () => {}, scanner, stallTicks: 3, onStall: (why) => stalls.push(why) });
    // 每次检查之间让探针完成：这里只看扫描，不让"文件操作"那条线索抢先
    const step = async (w, n) => { for (let i = 0; i < n; i++) { w.tick(); await new Promise(setImmediate); } };
    await step(wd, 3);
    scanner.progress = 8; // 有进展：大库重扫再久也不算卡死
    await step(wd, 3);
    assert.equal(stalls.length, 0);
    await step(wd, 1);
    assert.equal(stalls.length, 1);
    assert.match(stalls[0], /扫描/);
    const idle = []; const quiet = { scanning: false, progress: 8 };
    const wd2 = createStallWatchdog({ probe: async () => {}, scanner: quiet, stallTicks: 2, onStall: (w) => idle.push(w) });
    await step(wd2, 6);
    assert.equal(idle.length, 0, '空闲（没在扫描）不算卡死');
  });

  if (process.platform === 'win32') {
    console.log('  – 跳过真实进程用例（Windows 无命名管道夹具）');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'tw-stall-'));
  const running = [];
  try {
    await check('4 个线程卡住时面板仍能打开（线程池已加大，旧默认值 4 会整个卡死）', async () => {
      const s = await serveWithStuckThreads(root, 4); running.push(s);
      const res = await fetch(`http://127.0.0.1:${s.port}/`, { signal: AbortSignal.timeout(5000) });
      assert.equal(res.status, 200);
      assert.ok((await res.text()).length > 100);
    });

    await check('线程池被彻底占满：服务说明原因并自行结束，而不是悄悄停工', async () => {
      const s = await serveWithStuckThreads(root, 40, { TOKENMETER_STALL_TICK_MS: '100' }); running.push(s);
      const result = await Promise.race([s.exited, new Promise(r => setTimeout(r, 15_000, 'still running'))]);
      assert.notEqual(result, 'still running', s.output());
      assert.match(s.output(), /卡死/);
      assert.ok(result.signal === 'SIGKILL' || result.code !== 0, JSON.stringify(result));
    });
  } finally {
    for (const s of running) s.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
