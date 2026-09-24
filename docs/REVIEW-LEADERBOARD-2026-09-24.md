# 社区 Token 用量排行榜评审

日期：2026-09-24。范围：当前未提交的排行榜代码（本地 CLI/代理/前端及 `cloud/`）。
既有工作区其他改动保留；未读取、重启、迁移或上传真实用量库。

## 发现及本次修复

| 优先级 | 原实现问题与影响 | 处理 |
| --- | --- | --- |
| P1 | 日榜只看 48h 上报时间，没有使用 day；昨日巨量用量仍会压过今日用户，不同时区口径不一致 | 客户端与云端统一 UTC 日，服务端检查日期，日榜只取同日；排除客户端未来时间事件 |
| P1 | 换一个 ID 就能绕过写入节流，解析 JSON 前不限制请求体大小 | 每来源 IP/端点的边缘限流 + 16 KiB 流式上限 + UUID v4 校验；保留自报数据边界 |
| P2 | 个人排名只在 LIMIT 200 结果中查找；第 201 名以后得到 null，人数又包括零值用户 | 对全部有效用户排名，展示前 50 名并独立返回本人，人数与排名筛选一致 |
| P2 | 30 天删除只在新上报时触发，停止上报后可能永久保留 | 每天 03:17 UTC 清理超过 30 天记录；正常调度下最迟约 31 天 |
| P2 | 同 ID 节流丢弃新值，却返回 ok，客户端记录虚假成功 | 原子 upsert 检查变更行数，未接受上报返回 429 |
| P2 | GET 把匿名 ID 放在 URL；本地缓存不含参与者身份 | ID 改请求头，响应 no-store，缓存包含是否参与及 ID |
| P2 | 前端信任云端数值类型，部分值直插 innerHTML；切换日周榜时慢响应可覆盖新选择 | 所有远端插值转义，请求序号阻止旧响应覆盖 |
| P2 | healthz 不访问 DB，缺表/绑定出错仍显示健康 | 健康检查实际查询 players 表 |
| P2 | 关闭参与时，已经开始的异步聚合仍可能继续发送 | 发送前复查参与状态、昵称、服务地址与离线模式 |
| P3 | 网络异常不清理超时定时器，聚合异常在 try 外 | 统一 try/finally 处理，并记录失败状态 |

## 验证证据

- Node 24 隔离 HOME 下运行完整既有测试；加入 Worker SQL/协议及前端回归，最终 **494 项通过**。
- Worker 测试使用真实内存 SQLite 执行生产 SQL，D1 适配器仅包装接口。
- 已通过真实 workerd + 本地 D1：建表、健康检查、JSON 上报、日/周榜、重复 429、大包 413、scheduled 清理。
- Wrangler 4.138.0 固定版本及锁文件；dry-run 构建成功，D1 / RateLimit 绑定被识别。
- 前端竞态及 XSS 回归通过。日志：`/private/tmp/token-leaderboard-review-tests.log`。
- 项目没有配置独立 lint/format 命令；执行 Node 语法检查与 git diff --check。

云端状态：已部署到用户指定账号的 Workers Free（$0）计划，地址为
https://token-watcher-leaderboard.ygnjd2016.workers.dev 。
版本 ea1d541e-9172-4f2c-a1cf-7dabb616b1bd，D1 专用库位于 WNAM；绑定与每日 03:17 UTC 清理任务已发布。
cloud/smoke.mjs 在线上完成 8 项检查：健康及 D1、上报、同 ID 节流、日榜、周榜、非法 ID、旧日期、大包拦截。
合成测试记录已按 UUID 精确清除；随后通过实际 fetchLeaderboard 函数确认榜单 0 人且个人记录不存在。
证据：cloud/deployment.json、/private/tmp/token-leaderboard-live-smoke.json。
客户端默认地址已更新；未发布 npm 包、未重启本地服务、未开启真实用量上传。
Chrome 公开地址预览遇到 net::ERR_BLOCKED_BY_CLIENT；命令行 HTTPS 与项目客户端均通过，浏览器访问限制仍需区分。

## 仍存在的产品边界

1. **数据未验证**：用户可改本地统计或直接构造上报；IP 限流不能阻止多来源刷榜，不能用于奖金或正式竞技排名。
2. **匿名 ID 是写入凭据**：没有账号恢复机制；泄露 ID 可以覆盖该条目。服务端不公开 ID，请求 URL 不携带 ID，远端地址要求 HTTPS。
3. **统计是快照**：每小时上报，近 7 天榜使用最近 24h 的快照；用户离线后不会即时消失。
4. **ROI 非统一日周收益**：继承现有本地自然月 API 等值/月费算法，非真实账单收益；重叠订阅模型范围、未知价格及积分制的比较能力有限。
5. **基础设施配额**：SQL 排名仍扫描活跃集合；人数扩大后需根据 D1 rows_read 设计汇总/缓存。边缘限流按 Cloudflare 位置计算，非全局精确上限。
6. **退出不立即删除**：客户端 off 停止上报；正常 cron 调度下 30–31 天删除残留。Cloudflare 网络元数据处理不等于应用表的隐私声明。

文档依据：[Cloudflare 限流绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、
[D1 免费配额](https://developers.cloudflare.com/d1/platform/pricing/)。
