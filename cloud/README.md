# 社区排行榜服务端（Cloudflare Workers + D1）

token-watcher 的可选排行榜后端，公开自报数据 API。使用 Workers / D1 免费计划；
是否足够取决于请求数及 D1 扫描/写入行数，超过免费配额会影响可用性，不自动升级付费。
**整个服务只存聚合数字**：昵称、随机匿名 ID、今日/近 7 天/近 30 天 token 总量、请求次数、
各周期主力模型及占比、近 7 日模型/工具占比、订阅 ROI 比值（×N，不含金额）。无参与者账号、无原始明细。
应用数据库不存 IP；Cloudflare 边缘会处理 IP 并用于短期限流，不能承诺服务商不处理网络元数据。

官方 API 已部署：[日榜](https://token-watcher-leaderboard.ygnjd2016.workers.dev/leaderboard?period=day)、
[健康检查](https://token-watcher-leaderboard.ygnjd2016.workers.dev/healthz)。
这是排行榜后端，图形界面仍在本机 token-watcher 面板中；根路径不提供网页。
部署版本、时间与源码指纹见 `deployment.json`。客户端源码默认地址已同步，已安装的旧版可执行：

```bash
tokenwatcher leaderboard url https://token-watcher-leaderboard.ygnjd2016.workers.dev
```

更换地址不自动开启上报。参与需自行执行 `tokenwatcher leaderboard on <昵称>`。

## 部署官方实例

```bash
cd cloud
npm ci
cp wrangler.toml.example wrangler.toml
npx wrangler login --scopes account:read user:read workers_scripts:write d1:write
npx wrangler d1 create token-watcher-leaderboard   # 输出 database_id
# 将输出的 database_id 填入 wrangler.toml；多账号时同时显式配置 account_id
npm run check                                  # 仅构建，无远端修改
npx wrangler d1 execute token-watcher-leaderboard --remote --file=schema.sql
npm run deploy
```

部署后把最终 URL（`https://<name>.<你的子域>.workers.dev`）填进
`src/leaderboard.js` 的 `LEADERBOARD_URL_DEFAULT` 再发 npm 版；
或让用户自行指向：`tokenwatcher leaderboard url <https://…>`。
`wrangler.toml`、`.wrangler/` 与凭据不提交到版本库。仓库中固定 Wrangler 版本及锁文件。

## 升级已有数据库（近 30 日榜）

新库使用完整 `schema.sql`。已有库应先执行一次增量迁移，再部署新 Worker：

```bash
npx wrangler d1 execute token-watcher-leaderboard --remote --file=migrations/0001_month_tokens.sql
npx wrangler d1 execute token-watcher-leaderboard --remote --file=migrations/0002_period_models.sql
npx wrangler d1 execute token-watcher-leaderboard --remote --file=migrations/0003_anti_forgery.sql
npm run deploy
```

0001、0002 只新增可为空的字段及索引，保留所有记录；不要重复执行已完成的迁移。
0003（防伪造）新增按天记录表与封禁表，并**删除按新规则会被拒收的已有记录**；
7 / 30 天改为服务端累计，已有用户以各自最近一天的上报为起点重新累计，历史不补入。
**先迁移再部署**：新 Worker 依赖 0003 的表。
之后升级/重启客户端服务，下一次上报才会提供 30 日总量；可用 `leaderboard push` 立即更新。

## 时间与排名口径

- `day` 统一为 UTC 自然日。旧日期不能重新上报，昨天的记录不进入今天的日榜。
- `week_tokens` / `month_tokens` 由**服务端按天累加**：含今天在内最近 7 / 30 个 UTC 自然日、
  每天取该 ID 当天最后一次上报的值。客户端报的滚动总量只用于一致性检查，不上榜——那是最容易伪造的数字。
  代价：服务端没见过的天（加入前、断网、关机）不计入。超过 24 小时未上报不再参与排名。
- 旧客户端（不报 `month_tokens`）同样按服务端累计进入 30 日榜。
- 主力模型按所选日/7日/30日周期的 Token 总量排序，只显示第一名；占比除以同期全部 Token 后取整。并列按模型 ID 排序，不合并不同版本。
- `models_by_period` 为各周期独立模型及占比；旧 `models` 保留近 7 天 Top5 以兼容旧 Worker。旧报告只能提供周主力，日/30 日模型返回空及 `models_period:null`，页面提示待更新。
- 日榜只比较同日数据，显示前 50 名，但可以返回任意名次的个人排名。
- 相同数值以稳定 ID 决定显示顺序；人数只计算当前指标大于零的有效记录。
- ROI 是用户本地自然月的 API 等值/月费比，不是日/周收益，更不是实际节省金额。
- 所有用量均为客户端自报，**无法证明真伪**（数据来自用户本机，代码开源），不适用于奖励发放或正式竞赛。
  服务端能做的是让造假变难、变显眼、可处理，见下方「防伪造」。

## API 与验收

- `GET /healthz`：验证 D1 表可查询，成功为 `200 ok`。
- `POST /report`：JSON，≤16 KiB，`v:1`、随机 UUID v4、当前 UTC 日期。不合理的用量返回 `400`
  并附原因（见「防伪造」）；被封禁的 ID 返回 `403`。
- `GET /leaderboard?period=day|week|month&metric=tokens|roi`：公开榜单。
- 可选 `X-Leaderboard-ID` 请求头返回个人排名；ID 不放入 URL，也不在响应中公开。
- 同 ID 60 秒内重复上报返回 `429`，不会冒充成功。跨域预检支持上述请求头。

本地回归：仓库根目录 `npm test`（合成 SQLite + Worker SQL 协议验证）。
运行时验证：`npx wrangler d1 execute token-watcher-leaderboard --local --file=schema.sql`，
再执行 `npx wrangler dev --local --test-scheduled`。只使用合成数据。
线上烟测：`node smoke.mjs <worker-url> <receipt.json>`，会写入一条合成记录；
测试结束后通过 Wrangler 执行 receipt 中的精确 `cleanup_sql`，再验证该 ID 不在榜。

## 自托管

任何人都可以跑自己的实例（工会/团队内部榜）：

```bash
tokenwatcher leaderboard url https://your-worker.workers.dev
tokenwatcher leaderboard on <昵称>
```

面板与 CLI 的所有上报/拉取都会改走该地址。

## 隐私与滥用防线

- 客户端默认**关闭**，`tokenwatcher leaderboard on <昵称>` 显式开启；
- 上报字段清单见仓库 README「社区排行榜」章节，代码可审计（`src/leaderboard.js`）；
- 昵称：1-16 码点、去控制符/零宽、拒链接与 @、脏话/冒充官方黑名单，非法回退"匿名-xxxx"；
- 占比 0-100、列表 ≤8 条等形状字段客户端与服务端各钳一次；用量数字不截断，不合理直接拒收（见下）；
- 同 ID 60 秒节流；Cloudflare 边缘按来源 IP、端点限流（每位置 60 次/分钟，非全局精确配额）；
- 每天 03:17 UTC 清理超过 30 天未上报的行，正常调度下最迟约 31 天（含退出后残留）；
- 显式关闭 Worker observability，应用不打印上报内容或身份标识；
- 榜单响应不含任何匿名 ID（服务端只借它定位"我的排名"）；
- 举报/清理：见下方「防伪造 · 封禁」。

## 防伪造

用量来自用户本机日志，代码开源、签名密钥藏不住，**服务端无法证明数据是真的**。
能做的是三层：

1. **不合理就拒收**（`lib.js` 的 `implausibleReason`，查的是截断前的原始值）。截断到上限反而会把
   造假者恰好送上第一名。阈值按 2026-09 真实重度用户（单日 11.2 亿 token / 6355 次请求 /
   单小时 3.5 亿）放宽 7~30 倍：

   | 检查 | 上限 |
   |---|---|
   | 单日 token | 200 亿 |
   | 从 UTC 零点起的增速 | 每小时 50 亿（零点半最多 75 亿） |
   | 单日请求 | 20 万 |
   | 当日平均每次请求 | 500 万 token |
   | 一致性 | 今天 ≤ 7 天 ≤ 30 天；有用量必有请求 |

2. **7 / 30 天由服务端按天累加**（`daily` 表）。想冲上 30 日榜，就得连续多天、每天都按合理节奏上报。
   三步写入（玩家行 / 当天记录 / 重算总量）在同一个 D1 事务里，以每次请求的随机写入标记确认未被节流。

3. **封禁**：被封 ID 的上报一律 `403`，只删行的话下一小时就会被插回。管理走本地脚本、底层调用
   wrangler（要求已登录且有 D1 写权限），**Worker 上不开管理接口**，不多一个凭口令就能写库的入口：

   ```bash
   cd cloud
   node admin.mjs find <昵称>              # 公开榜单不返回 ID，这里查
   node admin.mjs top month                # 前 20 名及 ID
   node admin.mjs ban <ID> 刷榜             # 删除玩家行与按天记录，此后上报 403
   node admin.mjs unban <ID>
   ```

   新 ID 随手可生成，封禁挡的是"同一个 ID 被删后再插回"；换 ID 重来仍要过前两层。

配额与限流依据：[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)、
[Workers 限流绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

## 字段一致性

`cloud/lib.js` 与 `src/leaderboard.js` 的 `sanitizeName` / `clampReport` 是刻意
的重复（npm 包不含 cloud/，Worker 不依赖 src/）；`test/run.mjs` 用同一组用例
断言两侧输出完全一致，改动时两处同步改。
