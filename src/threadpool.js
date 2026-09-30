/**
 * 加大 libuv 线程池。必须是入口的第一个 import：线程池大小只在首次使用前读取一次。
 *
 * 默认 4 个线程，由异步文件操作与域名解析共用；几个请求卡在解析里就能把扫描和面板一起拖死
 * （见 netGate.js）。16 个给其他来源的卡顿留余量，空闲线程不占 CPU。
 * 用户自己设过就尊重。macOS / Linux 实测运行时设置有效；Windows 上 libuv 读不到运行时
 * 改动的环境变量，需在启动前设置 UV_THREADPOOL_SIZE，那里仍靠 netGate 与卡死自检兜底。
 */
process.env.UV_THREADPOOL_SIZE ||= '16';
