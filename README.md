# Token Watcher

**Mac 本地多源 AI Agent 用量与配额实时面板。** 一个常驻进程解析你机器上各 AI 编码工具留下的本地会话记录，统一归一化为 token 事件流，提供 Codex 风格的统计面板、实时配额卡、厂商余额轮询、费用估算与菜单栏胶囊。零框架依赖、纯本地运行。

![Token Watcher](https://raw.githubusercontent.com/luwill/token-watcher/main/docs/screenshot.png)

> 截图为真实运行数据（厂商余额与项目名已脱敏为 ••••）。

## 支持的工具（9 源）

| 工具 | 数据位置 | 能看到什么 |
|---|---|---|
| Claude Code | `~/.claude/projects` | 逐请求 token 明细、模型分布 |
| ccmr（claude-code-model-router） | `~/.claude-gateway/projects` | 同上（国产模型隔离目录，真实模型名） |
| Codex | `~/.codex/sessions`、`archived_sessions` | token 明细、**官方配额百分比与重置时间**（5 小时 / 每周窗口）、模型（含 auto-review 子代理）、工具调用 |
| ZCode | `~/.zcode/cli/db/db.sqlite` | 逐请求明细（model_usage 表）、工具调用 |
| dsh（DeepSeek Harness） | `~/.dsh/sessions` | 逐请求明细（zstd 压缩会话） |
| WorkBuddy | `~/.WorkBuddy/projects` | 逐请求明细 + **积分费率自学习**（credit 账本 × token 最小二乘） |
| Grok Build | `~/.grok/sessions` | 轮次用量明细（含厂商侧成本刻度）、工具调用 |
| Pi | `~/.pi/agent/sessions` | 逐请求明细、工具调用（会话 JSONL 自带 USD 成本明细） |
| OpenCode | `~/.local/share/opencode/opencode.db` | 逐请求明细（message 表）、工具调用 |

不支持的：网页版聊天（ChatGPT/豆包/DeepSeek 网页等）——token 计数在服务端，本地无留痕，原理上不可统计。

## 快速开始

三种用法，按"要不要长期用"来选。

### 方式一：npx 试用（什么都不装）

```bash
npx --yes token-watcher@latest serve
open http://127.0.0.1:8787
```

关掉终端即停止，适合先看看有没有用。

两个参数都别省：`--yes` 跳过安装确认；`@latest` 绕开 npx 的版本缓存——不加的话它
可能跑到一个早先缓存的旧版本。另外 npx 会优先解析**本地**依赖，所以如果你正好在
本仓库目录里执行，跑的其实是仓库代码而非 npm 上的包。

### 方式二：npm 全局安装（长期使用，推荐）

```bash
npm install -g token-watcher
token-watcher serve
```

装完除了 `serve`，还多出两个只有全局安装才方便用的能力：

```bash
# 常驻 + 开机自启（macOS，崩溃自动拉起）
token-watcher install-agent
token-watcher install-agent --port 9000
token-watcher uninstall-agent

# 菜单栏胶囊（macOS）
token-watcher bar
token-watcher bar --port 9000   # 服务不在默认端口时
```

`install-agent` 会把 node 与入口脚本的**绝对路径**固化进 LaunchAgent——launchd 的
PATH 是系统默认，既不含 npm 全局 bin（前缀还可能被改过），也不保证含 homebrew，
靠命令名会起不来。日志在 `~/.tokenmeter/logs/`。停用请用 `uninstall-agent` 或
`launchctl bootout`，`launchctl stop` 会被 KeepAlive 立刻拉起。

菜单栏 app 以 universal 二进制随包发布（arm64 + x86_64，约 340KB），不需要 Xcode
工具链；从菜单里选「退出」可关闭。

三个命令名等价：`token-watcher` / `tokenwatcher` / `tokenmeter`（后者是旧名别名）。

### 方式三：克隆仓库（想改代码）

```bash
git clone https://github.com/luwill/token-watcher.git
cd token-watcher && npm install
npm run serve        # 首扫历史 ~3.3GB 约 6 秒，仅首次
```

```bash
npm test             # 回归测试，零依赖、离线可跑
npm run build-bar    # 重新编译菜单栏 app（需 Xcode CLT；发版时 prepack 会自动跑）
```

仓库里不含编译产物，`.app` 由 `prepack` 在发版前构建。所以克隆后想用菜单栏胶囊，
需先执行 `npm run build-bar`。

### 三种方式的差别

| | npx | 全局安装 | 克隆仓库 |
|---|---|---|---|
| 面板 / 采集 | ✓ | ✓ | ✓ |
| 菜单栏胶囊 | ✓ | ✓ | 需先 `npm run build-bar` |
| 开机自启 | 不建议 | ✓ | ✓（指向仓库路径）|
| 升级 | 每次拉最新 | `npm i -g token-watcher` | `git pull` |

npx 下不建议装开机自启：生成的 LaunchAgent 会指向 npx 的缓存目录，而那个目录随时
可能被 npm 清理，届时服务会静默起不来。要常驻就用全局安装。

### 其他命令

```bash
token-watcher today              # 终端速览今日消耗
token-watcher scan               # 只扫描一次
token-watcher serve --port 9000
```

## 运行要求

**Node ≥ 22.13**（`node:sqlite` 自该版本起免 `--experimental-sqlite` flag，零原生依赖）。

**dsh 源需要系统 `zstd`**（`brew install zstd`）。dsh 的会话快照是追加式多帧写入，
单个文件可达数千帧，而 Node 内置的 zstd 只解第一帧就结束且不报错，因此这里以外部
`zstd` 为准，仅在确认文件只含单帧时才回落内置实现。未安装且遇到多帧文件时，该源会在
健康自检里报错，而不是静默少算。其余数据源不需要它。

**平台支持：macOS 全功能验证**（含菜单栏 App 与 launchd）。Windows / Linux 上核心链路（采集、面板、API）随 CI 在 macOS + Ubuntu + Windows 三平台跑回归，包含"装成依赖后能否真正跑起来"的安装冒烟。菜单栏 App 与 launchd 开机自启为 macOS 专属。

开发与测试：`npm test` 运行五层回归——语法检查、import 冒烟（拦模块级错误，`node --check` 看不见）、静态断言、前端纯函数行为、端到端冒烟（fixtures 黄金数字 + 幂等 + API 结构）。零依赖、离线运行，GitHub Actions 上跑 macOS/Ubuntu × Node 22.13/24 矩阵。

## 功能

- **实时**：FSEvents 监听各数据目录 → 增量解析 → SSE 推送，面板秒级刷新（实测 <1s）
- **增量采集**：字节级游标 / sqlite 水位 / 快照重解析三种策略，二次扫描 0ms；dedup 键保证幂等；采集器版本号机制支持逻辑升级后自动全量回填
- **统计面板**：指标卡、近一年 GitHub 风格日历热力图（每日/每周/累计）、按天/模型/工具图表、最近请求实时流
- **会话钻取**：点击趋势图任意一天 → 会话列表（峰值上下文估算）→ 单会话逐请求 token 曲线
- **工具活动**：四源工具调用频次榜
- **配额**：Codex 官方配额直读（百分比/重置倒计时）、Claude 订阅 5h 窗口推算（session-blocks 法）
- **余额与费用**：DeepSeek/Kimi 余额轮询（读 `~/.ccmr/.env` 的 key，密钥不出后端）；ccmr 侧按官方牌价折算（`~/.tokenmeter/pricing.json` 可编辑）+ 余额对账
- **阈值通知**（菜单栏 App）：Codex ≥80%/95%、余额 <¥10/¥2 弹 macOS 通知，级别上升只提醒一次
- **数据源健康自检**：解析错误标红、"文件在写但无新事件"标黄——私有格式漂移不再静默失败
- **导出与备份**：CSV 导出、每日 `VACUUM INTO` 备份保留 7 份

## 隐私

- 纯本地：只读取上述本地文件，**不上传任何用量数据**，面板只监听 127.0.0.1 且校验 Host（挡 DNS rebinding）
- API 密钥仅在服务进程内使用（调厂商余额接口），不入库、不进前端
- 统计库只存聚合事件（时间/工具/模型/token 数/项目名），不存对话内容

**出站请求清单**（只有这三类，都不携带你的用量数据）：

| 用途 | 端点 | 频率 |
|---|---|---|
| USD→CNY 汇率 | `open.er-api.com`、`cdn.jsdelivr.net` | 12 小时，本地缓存兜底 |
| 模型牌价 | `raw.githubusercontent.com`（LiteLLM 价格表） | 24 小时，本地缓存兜底 |
| 厂商余额 | DeepSeek / Kimi 官方接口（带你的 key） | 30 分钟，连续失败自动熔断 |

要完全断网运行，设 `TOKENMETER_OFFLINE=1`：三类请求全部跳过，改用本地缓存与
`~/.tokenmeter/pricing.json`（可设 `usd_to_cny` + `usd_to_cny_manual: true` 固定汇率）。
回归测试即以此模式运行，不依赖公网。

## 免责声明

Token Watcher 是**非官方**工具，解析的均为各产品留在本地的**私有格式**（无稳定性承诺），上游版本升级可能导致个别源解析中断——健康面板会标出，欢迎提 issue。各产品版权归其厂商所有。

## 架构

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。核心：`src/collectors/*` 每源一个适配器（增量 + dedup + 版本号），`src/scanner.js` 统一调度，SQLite 归一化事件表，`src/server.js` HTTP API + SSE，`web/` 零构建前端（ECharts UMD）。

**添加新数据源**只需：写一个 collector（实现 `collect(store, {path, offset, state})` → `{inserted, newOffset, state}`）、在 `src/config.js` 注册、前端加一个颜色。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Roadmap

- 跨平台验证（Linux/Windows）
- 订阅 ROI 视角：API 等值成本 vs 订阅实付
- 按项目维度的用量与花费
- 配置文件（数据目录 / 端口 / 告警阈值）
- i18n / 英文 README

## 更新日志

### 1.4.4（2026-09-18，待发布）

- **修复 Codex plus 用户的配额卡显示成 5 小时额度。** Codex 上报的配额分 primary / secondary
  两个位置，但位置不代表窗口：plus 套餐 primary 是 5 小时、secondary 才是周额度；pro 只有
  primary，且是周额度。此前一律取 primary 并标成"周配额"，plus 用户看到的其实是 5 小时额度
  （卡片上"0 天窗口"就是 300 分钟被当成天数取整的结果）。现在按窗口时长识别，卡片更名为
  「Codex 配额」，有几个窗口就显示几条：plus 显示 5 小时与每周两条，pro 只显示每周
- 修复配额被非主额度的快照顶掉：使用 GPT-5.3-Codex-Spark 时 Codex 会上报一份独立额度，
  另有一种窗口全空的快照，此前只要它们是最新一条，就会让配额卡显示成 Spark 的额度或 0%
- 升级前存下的旧快照无需重扫即可正确显示；下一次使用 Codex 时自动换成完整的窗口数据
- 重置倒计时满一天时显示"3天23时58分"，不再显示成"95时58分"
- 修掉一条会随运行时刻变红的测试：美元折算用例的事件取"1 小时前"，落在 DeepSeek 谷时就被减半

### 1.4.3（2026-09-17）

- **修复 OpenCode 漏采约八成消息。** OpenCode 的 assistant 消息是"先插后改"：开始生成就插入
  一行（用量全 0），生成结束才原地更新写入用量。采集器按 rowid 增量，而服务监听数据库写入、
  生成过程中就会触发扫描——这行被当成 0 用量跳过，水位却越过了它，完成后的更新再也读不到。
  面板表现为 OpenCode 明明在用却显示"疑似停更"。现改为按 `time_updated` 增量；升级后自动
  全量重扫，补回历史漏采的消息（实测 99 条中原先只采到 20 条，修复后 99/99、token 总量逐一吻合）
- 修掉一条会随日期自己变红的测试：余额对账用例把事件时刻写死在某一天，而对账窗口是"最近 24 小时"

### 1.4.2（2026-09-16）

- **修复 1.4.1 引入的回归：dsh 整源静默归零。** 1.4.1 把 zstd 解压改为优先使用 Node
  内置实现（为解决 launchd 下找不到外部 zstd 的问题），但内置的 `zstdDecompressSync`
  与 `createZstdDecompress` 都只解**第一帧**就结束且不报错。而 dsh 是追加式多帧写入，
  实测单个会话文件有 5800+ 帧——外部 zstd 解出 19MB，内置实现只解出 226 字节。
  现改为以外部 zstd 为准（仍显式试常见绝对路径以解决 launchd 的 PATH 问题），
  仅在确认文件只含单帧时才回落内置实现，多帧又无外部 zstd 时大声报错而非静默少算。
  **使用 dsh 源的用户请从 1.4.1 升级。**

- 新增 `token-watcher install-agent` / `uninstall-agent`，把服务装成 macOS 开机自启项。
  此前 README 指向 `npm run install-agent`，但 npm scripts 对全局安装的用户不可见，
  且那条命令只负责 `launchctl bootstrap`、从不生成 plist，plist 也不随包发布——
  全局安装的用户实际没有可用的常驻方案
- 生成的 plist 固化 node 与入口脚本的绝对路径。launchd 的 PATH 不含 npm 全局 bin 与
  homebrew，而入口脚本的 shebang 是 `#!/usr/bin/env node`，靠命令名无法启动
- 检测到旧 `com.tokenmeter.server` 仍在运行时拒绝安装（两者抢同一端口），可用 `--force` 覆盖
- 新增 `token-watcher bar`，菜单栏胶囊随包发布。此前 `.app` 只存在于仓库、也不在
  发布白名单里，全局安装的用户拿不到，而指引用的 `npm run bar` 同样不可见
- 菜单栏 app 改为 universal 二进制（arm64 + x86_64）。此前产物只有 arm64，Intel Mac
  上无法运行；`prepack` 会在发版前自动重新编译，避免发出陈旧或缺失的产物
- 菜单栏 app 不再写死 8787 端口，`serve --port` 的用户不会再拿到连不上的胶囊
- 修掉菜单栏的数量换算：「亿」档阈值错写成 1e6 却按 1e8 换算，200 万会显示成 "0.0亿"

### 1.4.1（2026-09-16）

修掉一批让面板数字低于厂商账单的问题。起因是实测发现面板显示 DeepSeek 当日 ¥8.34，
而官方后台是 ¥58.24。定价表本身无误，问题全在数据进库之前。

- **ccmr 的输出 token 被钉死在 0**：Claude Code transcript 把一次响应按 content block
  拆成多行，只有终结块带真实 `output_tokens`；ccmr 网关又不写 `requestId`，分片塌成
  同一去重键，先到者胜留下的正是 output=0 的首块。实测单日丢掉 94.5% 的输出量。
- **dsh 自 2026-08-14 起整源静默归零**：上游把会话结构换到 v3（`assistant/chunk` →
  `assistant/message`，`data.chunk.usage` → `data.usage`），采集器一条也匹配不上，
  却照常返回 0 条且不报错。全库停在 165 条，而恢复后单日就有 790 次请求 / 1.07 亿 token。
- **守护进程解不开 zstd**：launchd 的 PATH 不含 homebrew 目录，dsh 快照只有手动
  `scan` 才解得开。改为优先使用 Node 内置 zstd（≥23.8），旧版本回落外部可执行文件。
- **DeepSeek 峰谷价未实现**：谷时用量一律按峰时价折算。峰时为 UTC 周一至周五
  01:00-04:00 与 06:00-10:00，其余时段半价。
- **余额对账漏算同账户的工具**：`computeRecon` 写死只统计 ccmr，而 dsh 花的是同一个
  DeepSeek 账户，导致对账永远显示巨大缺口。改为按注册表的 `apiBilled` 标记推导。

升级后首次扫描会全量重扫 ccmr 与 dsh 以补正存量数据。

### 1.4.0（2026-09-16）

- 新增 **Pi** 与 **OpenCode** 两个数据源（共 9 源）。两者口径均逐条核对
  `total == input + output + cacheRead + cacheWrite` 后才接入
- 健康自检的工具清单改为从数据源注册表推导。此前是另抄的一份硬编码数组，两份清单
  必然漂移，而漏登记的源不会报错，只是从健康自检里静默消失

### 1.3.1（2026-09-15）

- **装成依赖后面板全空**：ECharts 路径写死了嵌套 `node_modules`，而 npm 安装时会把
  依赖提升到顶层，于是 `/vendor/echarts.min.js` 返回 404、前端整个挂掉。改为交给
  Node 自己的解析算法
- 修掉两处 Windows 专属问题（目录分隔符解析）

### 1.3.0（2026-09-15，未发布）

- 补上与包名同名的 `token-watcher` 命令入口。改名后 bin 有多个条目且都不叫包名，
  `npx token-watcher` 失去确定的解析依据

### 1.2.0（2026-09-15）

- **服务不再会悄悄退出**：扫描时源文件被删（Claude 清理会话、Codex 归档搬移都是常态）
  会抛 ENOENT 冲垮整轮扫描，而这发生在防抖定时器回调里，等于未处理 rejection
- `scanning` 标志异常后不复位会让后续每轮扫描都被"并发中"挡掉，面板从此停更
- 补齐路由错误处理与 `busy_timeout`，一次 SQLITE_BUSY 不再能杀掉进程
- 清理已消失文件的游标行（只清 `files`，不动 `events`）

### 1.1.0（2026-09-15）

- 汇率实时化：公开接口拉取 USD/CNY，12 小时刷新 + 断网兜底
- 新增逐日 token 消耗图与按天 × 模型堆叠花费图（Top6 + 其他聚合，低价模型不再被静默丢弃）
- 布局重构为两列严格等高对齐
- 回归测试强化

### 1.0.0（2026-09-14）

- 首个版本：本地多源 AI Agent 用量与配额实时面板，7 源采集
- 费用折算接入 LiteLLM 实时牌价
- GitHub 风格热力图、会话钻取
- 三层回归测试（语法 / 静态断言 / 端到端冒烟）

## License

[MIT](LICENSE)
