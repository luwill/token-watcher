import { stat } from 'node:fs/promises';
import { DATA_DIR } from './config.js';

/**
 * 卡死自检：进程活着、端口开着、CPU 为 0，却不再采集——这种状态不会自己报错。
 *
 * 两种卡法都靠它发现：
 *  - libuv 线程池被占满（见 netGate.js）：任何异步文件操作都排不上队；
 *  - 扫描里某一个文件操作永不返回（网络盘、休眠的外接盘）：scanning 一直为 true，
 *    之后每一轮扫描都被"已有扫描在跑"挡掉，面板看着正常，数据却停了。
 *
 * 按检查次数计，不按挂钟时间计：睡眠唤醒时系统时间一次跳过几小时，按时间算每次唤醒都会误判。
 */
const TICK_MS = 30_000;
const STALL_TICKS = 10; // 连续 10 次（约 5 分钟）没有进展才算卡死；唤醒后解析超时通常 1 分钟内恢复

export function createStallWatchdog({ probe = () => stat(DATA_DIR), scanner = null, stallTicks = STALL_TICKS, onStall }) {
  let probing = false, probeTicks = 0;
  let lastProgress = null, scanTicks = 0;
  let fired = false;
  const stall = (why) => { if (!fired) { fired = true; onStall(why); } };

  function tick() {
    if (probing) {
      if (++probeTicks >= stallTicks) stall('文件操作长时间无法完成（线程池被占满）');
    } else {
      // 上一个探针没回来就不再发新的：自检不能自己把线程池占满
      probing = true; probeTicks = 0;
      let run;
      try { run = Promise.resolve(probe()); } catch { run = Promise.resolve(); }
      run.catch(() => {}).finally(() => { probing = false; }); // 出错也算"回来了"：卡死是指不返回
    }
    if (scanner?.scanning && scanner.progress === lastProgress) {
      if (++scanTicks >= stallTicks) stall('扫描长时间没有进展（某个文件读取一直不返回）');
    } else {
      scanTicks = 0;
      lastProgress = scanner?.progress ?? null;
    }
  }

  return { tick };
}

/** 常驻服务里启动自检；定时器不阻止进程退出 */
export function startStallWatchdog(opts, { tickMs = TICK_MS } = {}) {
  const wd = createStallWatchdog(opts);
  setInterval(() => wd.tick(), tickMs).unref?.();
  return wd;
}
