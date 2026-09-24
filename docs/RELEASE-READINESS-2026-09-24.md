# 2026-09-24 提交与发布就绪评审

当前结论：四项 P1 已修复，用户随后明确要求提交、推送和发布 1.8.0。P2 作为已知限制在 RELEASE-1.8.0.md 披露；1.8.0 完整回归 550 项、macOS universal 构建、真实 npm 打包及干净安装验收已通过，推送后以多平台 CI 通过作为发布门槛。

范围：当前工作区（HEAD e183a40 加未提交/未跟踪文件），不是仅评审最新的排行榜面板。部分缺陷来自既有版本，但依然影响此次发布。初次评审仅复现问题；随后按用户要求修复 R1–R4。修复和测试均限定于本地代码、临时 HOME、合成数据库和离线服务，未修改真实数据库或云端部署。

## P1：已修复（以下问题描述为初次评审快照）

### R1：昵称会覆盖 CLI 主命令

原位置：CLI 参数解析；现实现为 `src/cliArgs.js`，由 `bin/tokenwatcher.js` 调用。

`parseArgs` 在每个位置都识别顶层命令。`leaderboard on serve` 被解析成 `cmd=serve`，`leaderboard on scan` 变成扫描命令，`leaderboard on uninstall` 进入卸载分支，均不是加入排行榜。`uninstall` 在 macOS 有新版 LaunchAgent 时会卸载该后台服务，尽管用户只在设置昵称。

证据：直接提取现有解析函数到无副作用 VM，三种结果均已复现；未执行卸载命令。修复应只从命令位置识别顶层命令，其后的昵称保留为位置参数，补充重名昵称和未知命令测试。

### R2：Codex 去重键升级缺少旧库兼容

原位置：`src/store.js`、`src/codexKeys.js`；初次评审时构造函数未迁移旧路径键。

新写入会把 `codex:/old/sessions/rollout-abc.jsonl:some-event` 规范为基于文件名的键，但已安装旧版用户数据库中的原始路径键没有同步迁移。归档搬移、强制重扫或游标回退时，同一旧事件因此能再次写入。工具调用也有相同风险。

证据：在临时库插入一条旧键记录（100 tokens），再以相同来源键调用当前 `insertEvent`，得到 2 条、200 tokens。已有测试只覆盖“旧库已经规范化”的个人回退场景，不能证明公开发行的旧库升级安全。

修复应提供有备份/冲突合并规则的版本化迁移，或可靠的旧新键兼容去重；测试真实旧键、已规范化键、两种键混存以及工具调用。不能靠强制重扫解决。

### R3：“全部”静默退化为最近 30 天

位置：`src/server.js` 的 summary / CSV 路由。

`Number(days) || 30` 把合法的零值变成 30。前端的“全部”传 `days=0`，因此范围图表和导出 CSV 漏掉更早历史，累计卡却仍显示全量。

证据：合成数据为近期 200 + 100 天前 500；请求 `summary?days=0` 得到 `range_days=30`、累计 700、模型范围合计 200；CSV 仅一条近期数据行。应共用明确的参数解析，区分缺省、非法值和合法零。

### R4：逐行解析回调异常无法正常传播

位置：`src/collectors/lines.js` 的 data 事件回调。

`onLine` 在 stream 的 `data` 事件中直接执行，没有捕获异常并 reject/destroy 流。同步抛错会成为未捕获异常，不进入调用方 `await` 的 catch，可能造成 CLI 崩溃，或让常驻扫描停在未完成的 Promise/事务。

证据：合成文本的回调抛出错误后，子进程退出码 1，外层 catch 标记没有输出。应捕获异常、关闭流并 reject，验证文件事务回滚和下一文件可继续采集。

## R1–R4 修复与验证结果

- **R1**：只将第一个位置参数识别为顶层命令，后续保留为子命令和昵称；未知命令非零退出，且先于旧目录迁移执行。覆盖所有命令保留字、前置选项、选项值及 help/version，并用隔离 CLI 实际保存 `today` 昵称。
- **R2**：新增 `migration:codex-keys:v1` 版本标记。`BEGIN IMMEDIATE` 内规范 events/tool_calls 旧键、合并冲突并落标记；失败整体回滚。修改前完整行保存在同库 `codex_key_migration_backup`，包含旧表额外列，统计查询不读取该表。这是受影响行的恢复归档，不是独立数据库备份。
  - 相同事件保留输出 Token 更多的一条完整快照；输出相同时取总 Token 更多的一条；完全相同时保留规范键记录。不得逐字段取最大值或把重复副本相加。工具调用仅保留一次。
  - 临时真实旧表测试覆盖旧键、新键、混存、多个旧路径、Windows 路径、反向冲突、归档重放、重开库幂等、原始行完整归档，以及迁移中途失败后的原样回滚和重试。
  - 迁移在新版 Store 首次打开库时自动执行；本轮只在临时合成库运行。避免旧版写入进程与升级后的版本混用；恢复归档需停止写入并核对后续新增记录，不应直接覆盖当前库。
- **R3**：summary 与 CSV 共用范围参数解析，明确保留 `days=0`。缺省、空串、非数值、无穷、负数和小数回落为 30 天，超过上限限制为 3650 天。HTTP 测试同时核对范围、模型合计、按日合计、CSV 行数和总量，包含 100 天前数据。
- **R4**：捕获同步 onLine 异常，关闭流并 reject 给调用方。验证 callback 只执行到失败行、文件错误正确传播、UTF-8 跨块和半行续写不变；实际 Scanner 测试确认事务回滚、游标不推进、下一文件继续和下一轮重试成功。

验收：`test/release-blockers.mjs` 已接入 `npm test`，新增 24 项行为检查；完整测试共 **550 项检查通过**（不计末尾“全部通过”汇总行）。项目未配置独立 linter/formatter；已有语法检查、模块导入检查、完整回归及 `git diff --check` 均通过。日志：`/private/tmp/token-release-blockers-tests.log`。

## P2：必要收尾（本轮未改动）

| 问题 | 当前证据 | 建议 |
| --- | --- | --- |
| 端口重试重复启动后台任务 | `src/server.js:307-350` 在 listen 成功前启动轮询、监听器、备份及榜单定时器。合成服务遇 EADDRINUSE 后，poller start 从 4 次升到 8 次，update 监听器从 2 个升到 4 个 | listen 成功后统一启动生命周期，失败/关闭时清理；保证榜单上传只调度一份 |
| 缺价 ROI 显示为完整的零成本 | `src/roi.js:94-98`。有用量但无牌价、月费 100 的合成条目返回 `api_cny=0, ratio=0`，没有缺价状态；榜单总 ROI 也可能因此偏低 | 区分无用量与缺价，全缺价显示未知，部分缺价披露覆盖范围或不上传 ROI |
| 首次解析失败被当成空源 | `src/server.js:114-115`。空库 + `parse_errors=1` 返回 `status=empty` | 错误状态优先于空数据，防止 doctor 误报通过 |
| 菜单栏仍按旧 Codex 配额结构解码 | `menubar/main.swift:22` 仅有平铺 used_percent，后端输出 windows 数组；百分比和阈值通知代码仍读取旧字段 | 补 windows 契约和 Swift 解码测试；本轮为静态核验，未编译或触发系统通知 |

## 版本、依赖与提交清单

- 实时查询 npm registry：当前 latest 为 **1.7.0**，本地 package.json 也是 1.7.0，不能用该版本号再次发布。新增排行榜适合准备 1.8.0；package-lock.json 根包元数据仍是 1.1.0，应同步。
- `npm pack --dry-run --ignore-scripts --json` 成功：53 个文件，新增 src/leaderboard.js、src/codexKeys.js 和前端模块均包含；清单未包含 DB、环境文件、wrangler.toml、deployment.json 或评审文档。这仅验证包清单，没有验证本轮 prepack 原生构建和干净环境真实安装。
- .github/workflows/test.yml 已有 macOS/Linux/Windows × Node 22.13/24 的测试以及安装冒烟。此次尚未提交，未触发新的远端 CI；发布前应要求这些检查通过。
- `npm audit --omit=dev`：echarts 5.6.0 有 1 个中危 XSS 告警，0 高危/严重。已核对上游修复针对 **lines series tooltip**；当前 web 源码未使用 `type:'lines'`，不能把依赖命中直接说成产品可利用漏洞。升级 6.1+ 是跨主版本变更，宜独立做图表视觉回归；暂不升级则记录未触发路径及风险接受。
  - [Apache ECharts 官方修复 PR](https://github.com/apache/echarts/pull/21608)
  - [审计公告与影响版本](https://github.com/advisories/GHSA-fgmj-fm8m-jvvx)
- 待提交内容混合了排行榜、主题/图表调整、Codex 回退兼容及历史评审，建议按可独立验证的主题拆分。显式包含 cloud 源码/两份迁移、src/codexKeys.js 与新增测试；保持账号配置/本地缓存忽略。
- 旧排行榜评审中的部署版本、人数及“未上传真实用量”描述是历史记录，发布说明应引用最新 cloud/deployment.json，不能沿用旧状态当现状。

## 已有通过项与本轮边界

- 同一业务代码快照此前完整回归 **525 项通过**，Worker 线上合成验收 **9 项通过**；本轮未为重复验证而重跑无变化的完整测试。
- 今日/7日/30日排行榜、主力模型同步切换、UTC 日口径、旧客户端缺失周期的提示均已在本会话通过合成测试和实际服务验证。
- 新周期字段已迁移，Worker 版本为 `505ae204-2403-44b7-a619-f286acd8db1e`，原参与者保留，线上测试数据已清理。
- 初次评审的复现说明原有测试未覆盖旧库升级、保留字昵称、全部范围和流异常；本轮已将这些场景转为行为回归。
- 无需先做架构重写、引入前端框架或排行榜账号体系。D1 缓存/大规模排名优化可等真实参与人数与扫描行数证据再做。

证据路径（临时文件可能被系统清理）：

- `/private/tmp/tw-release-repro.mjs`：解析、旧键重复、流回调异常复现。
- `/private/tmp/tw-release-api-repro.mjs`：范围、轮询生命周期、ROI、health 合成复现。
- `/private/tmp/tw-release-registry.json`、`tw-release-audit.json`、`tw-release-pack-list.json`：本轮发布/依赖/包清单核验。
- `/private/tmp/token-leaderboard-model-period-tests.log`：525 项既有回归结果。

后续顺序：处理 P2，更新版本及发布说明，验证真实打包安装与三平台 CI，再发布候选版本。R1–R4 的本地修复已完成，本轮不扩大到上述收尾项。

## 2026-09-25 发布执行记录

- 发布代码提交 `1aa534c` 已推送 main，标签 `v1.8.0` 指向该提交。
- [GitHub CI](https://github.com/luwill/token-watcher/actions/runs/36024063487) 全部 10 个任务通过：三平台 Node 22.13/24 回归、三平台安装与模块导入。
- [GitHub Release](https://github.com/luwill/token-watcher/releases/tag/v1.8.0) 已公开，含安装包与 SHA256SUMS；tarball SHA-1 为 `40c5d22e07f671a31b94a23eda37443a2a7514a3`。
- npm 发布尚待账号持有人完成双重验证；不能将 GitHub Release 已发布表述为 npm 已发布。
