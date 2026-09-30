import { lookup } from 'node:dns';
import { isIP } from 'node:net';

/**
 * 外网请求的域名解析闸门。
 *
 * fetch 的域名解析走 getaddrinfo，它跑在 libuv 线程池里——与所有异步文件操作同一个池。
 * 唤醒后网络未就绪时 getaddrinfo 可以很久不返回；请求的超时（AbortController）只是
 * 不再等结果，线程并不释放。几个请求同时卡住就能占满线程池：扫描读不了目录、面板读不出
 * 页面，进程却空闲、CPU 为 0、端口照开（2026-09 用户实报，本地以占满线程池复现）。
 *
 * 所以发请求前先在这里解析一次，并限制"系统调用尚未返回"的解析数。名额以回调真正
 * 触发为准归还，不以超时为准——超时之后线程仍然卡着。解析通过后 fetch 自己的那次解析
 * 命中系统缓存，很快返回。
 */
const MAX_PENDING = 2;       // 最多让出 2 个线程给解析，其余留给文件操作
const LOOKUP_TIMEOUT_MS = 5000;
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

export function createDnsGate({ lookupImpl = lookup, timeoutMs = LOOKUP_TIMEOUT_MS, maxPending = MAX_PENDING } = {}) {
  const pending = new Set(); // 系统调用尚未返回的主机名

  /** 这个主机名现在能否解析。false = 别发请求（未就绪、断网，或解析名额已满） */
  function ready(hostname) {
    const host = String(hostname).replace(/^\[|\]$/g, '');
    if (LOCAL.has(host) || isIP(host)) return Promise.resolve(true);
    // 同一主机上一次解析还卡着：再发一次只会多占一个线程
    if (pending.has(host) || pending.size >= maxPending) return Promise.resolve(false);
    pending.add(host);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      lookupImpl(host, (err) => {
        pending.delete(host); // 只有这里才归还名额
        clearTimeout(timer);
        resolve(!err);
      });
    });
  }

  /** 包一层 fetch：解析未就绪时不发请求，抛出可读的原因（调用方本来就处理 fetch 失败） */
  const wrap = (fetchImpl) => async (url, opts) => {
    const { hostname } = new URL(url);
    if (!await ready(hostname)) throw new Error(`network not ready (DNS: ${hostname})`);
    return fetchImpl(url, opts);
  };

  return { ready, wrap };
}

const gate = createDnsGate();

/** 常驻服务里所有外网请求都走它，不要直接调全局 fetch */
export const netFetch = gate.wrap((url, opts) => fetch(url, opts));
