# Token Watcher 架构与数据源调研

> 本文档源自真实环境的逆向调研（2026-09），记录各数据源的本地格式、口径差异与设计决策。不含任何个人数据。

## 总体架构

```
bin/tokenwatcher.js      CLI（scan / serve / today）+ 一次性目录迁移
src/
  config.js              数据源注册表（kind + collector + version）
  store.js               SQLite（node:sqlite）：events / files游标 / quota / rates / tool_calls / balance_history
  scanner.js             按源类型枚举 + 增量扫描 + FSEvents + 版本回填 + resume链模型继承
  server.js              HTTP API + SSE + 健康计算 + Claude 5h 推算 + 每日备份
  balance.js             厂商余额轮询（DeepSeek/Kimi）
  pricing.js             ccmr 费用折算 + 余额对账
  rates.js               WorkBuddy 积分费率自学习（最小二乘）
  models.js              模型名归一化（跨源大小写合并）
  collectors/            每源一个适配器（claude / codex / zcode / dsh / workbuddy / grok / pi / opencode）
web/                     零构建前端（vanilla JS + ECharts UMD）
menubar/                 macOS 菜单栏 App（Swift/AppKit，需 .app bundle）
~/.tokenmeter/           运行时数据（库 / 备份 / pricing.json / 日志）
```

## 归一化事件模型

`(ts, tool, model, session_id, project, input_tokens[不含缓存], cached_input, cache_write, output_tokens, reasoning_tokens, total_tokens, trace_id, dedup_key UNIQUE)`

**口径**：Anthropic 系（Claude Code/ccmr/dsh/Pi/OpenCode）`input_tokens` 不含缓存，total = 四项之和；OpenAI 系（Codex/ZCode/WorkBuddy/Grok）input 已含 cached，入库拆为 新输入/缓存命中 两列。total = input + cache_write + output。

两类口径落库后是同一个公式：`total_tokens = input_tokens + cached_input + cache_write + output_tokens`。
`reasoning_tokens` 只作信息列，**任何源都不得把它再加进 total**——Pi 与 OpenCode 的 reasoning
都已含在 output 内，重复相加会凭空多算。

## 数据源格式笔记

### Claude Code / ccmr（同一解析器）
`~/.claude/projects/<项目目录>/<会话>.jsonl`，ccmr 用独立 `CLAUDE_CONFIG_DIR=~/.claude-gateway` 同格式。每条 type=assistant 记录的 `message.usage` 即一次 API 调用；`model="<synthetic>"` 为本地合成消息须过滤；同一 message.id+requestId 会因分片重复出现 → 全局 dedup。工具调用在 content[] 的 tool_use 块。

**一次响应被拆成多行，只有终结块带真实 output_tokens。** 一条 assistant 消息按 content block 分行写入（`apiBlockIndex` 0..n），共享同一个 `message.id`，`input_tokens`/`cache_read_input_tokens` 每行重复，而 `output_tokens` 在前置分片里全是 0，只有最后一块是真值：

```
block0 thinking   3594/47360/0
block1 text       3594/47360/0
block2 tool_use   3594/47360/0
block3 tool_use   3594/47360/309   ← 唯一带真实输出的一行
```

官方 Claude Code 每行都重复携带最终 output，取首行等于取最大，看不出问题；**ccmr 网关不写 `requestId`**（官方每行都写），dedup_key 退化成 `tool:msg.id`，四个分片塌成一行，"先到者胜"留下的正是 output=0 的首块。2026-09-16 实测当日丢掉 94.5% 的输出量。

因此 `store.insertEvent` 的去重语义是**"输出更大的后来者补齐该行"**而非纯 `INSERT OR IGNORE`：无冲突时行为不变，且能扛住分片跨增量扫描轮次落到不同批次的情况。不采用"跳过 `stop_reason == null`"，是因为那会新增一条静默丢弃路径——某个源一旦不写该字段就整源归零，正是下面 dsh 踩过的坑。

### Codex（坑最多）
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`：
- `token_count.info.total_token_usage` 是**会话累计值**，按相邻事件差分取单次用量；差分 0 的重复通知自然跳过
- **resume/fork 会话继承父线程累计基线**——若直接对"每文件终值"求和会把同一对话重复计数（实测差 9 倍），差分 + 首事件建基线天然正确
- 模型名版本漂移：新格式在 `thread_settings_applied.thread_settings.model`，旧格式在 `turn_context.payload.model`；续写文件两者皆无 → 按 `session_meta.parent_thread_id` 继承链回填（dedup 只防重插不更新旧行，需显式 UPDATE）
- `rate_limits` 为账号级配额快照，只保留全局最新（按 ts，与扫描顺序无关）。解析在 `src/codexQuota.js`：
  - **primary / secondary 是位置不是含义**，按 `window_minutes` 认窗口：plus 为 primary=300（5 小时）、
    secondary=10080（周）；pro / prolite 只有 primary=10080。同一套餐也在两种形态间切换过
  - 同一条流里混着非主额度的快照：`limit_id=codex_bengalfox`（GPT-5.3-Codex-Spark 的独立额度）、
    窗口全空的 `premium`。只收 `limit_id` 为 `codex` 或缺失（旧版）的快照，没有窗口的不入库
  - 升级前存的旧形态（只取了 primary 的平铺字段）由 `codexQuotaView` 在输出时转成窗口列表，
    不为单条"最新值"全量重扫 rollout
- 工具调用在 `response_item` 且 `payload.type=function_call`（name/call_id）
- `codex-auto-review` 是 Codex Desktop 内置自动审查子代理的模型槽位，真实用量

### ZCode
`~/.zcode/cli/db/db.sqlite`（WAL，可只读并发）：`model_usage` 表逐请求明细（rowid 水位增量；实测 computed_total=input+output 推得 input 含 cached）；`tool_usage` 表逐工具调用；`session.directory` 取项目名。**WAL 写入不改变主文件 mtime**——mtime 跳过判断对 sqlite 源无效，须每轮执行水位查询（微秒级）。

### dsh
`~/.dsh/sessions/**/session*.jsonl.zstd`（zstd 压缩，快照式：mtime 变化整体重解析 + dedup）。模型优先取记录自带的 `data.message.source.model`，回落顺序解析 `request/header.config.model`；cwd 在 `session` 记录。口径：input 不含缓存，reasoning 已含在 output 内，`total = input + cacheRead + cacheWrite + output`（v3 自带 `totalTokens`，实测 548/548 恒等）。

**两种记录结构并存，必须都认：**

| | 旧 `session.jsonl.zstd` | v3 `session.v3.jsonl.zstd` |
|---|---|---|
| 记录类型 | `assistant/chunk` + `chunk.type=='usage'` | `assistant/message` |
| usage 路径 | `data.chunk.usage` | `data.usage` |
| 字段名 | `inputTokens` / `cacheReadTokens` 等 | 不变 |

2026-08-14 dsh 切到 v3，采集器当时只认旧结构，于是**打开文件、一条也匹配不上、返回 0 且不抛错**，整源静默归零一个月（全库停在 165 条，而那之后单日就有 548 次请求 / 5,960 万 tokens）。文件发现一直是按 `.zstd` 通配的，所以表面上"扫到了文件"——没有任何一层会为"解析出 0 条"报警，这是它能瞒一个月的原因。

会话键用父目录名。迁移期新旧两个快照会并存于同一目录，因此 **v3 的 dedup_key 额外带上文件名**（`dsh:${fileId}:${file}:${seq}`），否则 seq 相同的两条互相顶掉；旧结构的键保持原样，避免历史事件在重扫时被当成新行再插一遍。

### WorkBuddy
`~/.WorkBuddy/projects/<目录>/<会话>.jsonl`（Electron 版 transcript）：`message.usage`（input 含 cache）；`providerData` 携带真实模型名（sessions 表的 model 列只是别名如 fast-model）与 traceId。
- `workbuddy.db.session_usage` 是上下文水位表（used=最近请求 input_tokens，非累计）
- `credit_json` 键 = 轮次 traceId、值 = 该轮积分消耗 → 与事件表按 trace_id 连接可**经验性标定积分费率**（纯单模型轮次无截距最小二乘，实测残差≈两位小数舍入）；混合轮次与 <3 样本不参与
- SQLite 为 WAL 写入，transcript 与水位表同秒落盘

### Grok Build
`~/.grok/sessions/<URL编码项目目录>/<会话id>/updates.jsonl`：`turn_completed.usage` 带全量明细（含 cachedRead/reasoning/modelCalls/costUsdTicks 厂商成本刻度）与 `modelUsage` 逐模型拆分；timestamp 为 Unix 秒。工具调用在 `tool_call` 事件（title/kind）。注意 `_meta.totalTokens` 是会话上下文水位而非轮次用量，勿用。

### Pi
`~/.pi/agent/sessions/<编码cwd>/<ISO时间>_<会话uuid>.jsonl`，追加式。用量在 `type=message` 的
`message.usage`（input/output/cacheRead/cacheWrite/reasoning + **逐项 USD 成本**），工具调用在
assistant 内容的 `toolCall` 块。
- **project 只能取首行 `type=session` 的 `cwd`**：目录名把 `/` 换成了 `-`（`--Users-x-Vibing-daily-test--`），
  `daily-test` 与 `daily/test` 编码后同形，无法反推。而增量扫描从字节游标往后读、读不到首行，
  所以 project 必须随 collector state 落库带过后续轮次，否则续写的事件会是 `project=null`（静默）
- 会话 id 取文件名 `_` 之后的 uuid（实测与 session 记录的 id 一致），去重键为 `pi:<会话>:<记录id>`；
  记录 id 只有 8 位十六进制，**不带会话前缀会在数万条量级上生日碰撞**
- 模型名保留厂商原样：openrouter 通路是 `deepseek/deepseek-v4-flash-0731`，与直连的 `deepseek-v4-flash`
  是不同价格的不同路由，**不做前缀剥离合并**
- 用量全 0 的记录（空调用/中断）按 `total <= 0` 跳过，与 Grok/ZCode 一致

### OpenCode
`opencode.db`（SQLite + WAL）。库位置随 XDG 走——`$XDG_DATA_HOME` 或 `~/.local/share`，
Windows 下 `%LOCALAPPDATA%`（取自其可执行体内的字符串常量），三个候选全登记、不存在的跳过。
- 一条 assistant `message` = 一次 API 调用，用量在 `data` 列 JSON 的 `tokens`
  （实测 session 表的 `tokens_*` 聚合列恰等于各 message 之和，故 message 级不重不漏）；
  user 消息没有 `tokens`，须跳过而不是记成 0 用量事件
- 工具调用在 `part` 表 `data.type='tool'`（`tool` 为名、`callID` 去重）
- **message 按 `time_updated` 水位增量，不能按 rowid**：assistant 消息是"先插后改"——开始生成
  就插入一行（`tokens` 全 0），生成结束才原地 `UPDATE` 写入用量并刷新 `time_updated`（实测
  1.18.31，每条消息恰一个 `step-finish`，用量只写这一次）。服务监听 `-wal`，生成过程中的写入
  本身就会触发扫描，扫描几乎总落在"已插入、未完成"的窗口里：0 用量被跳过、rowid 水位却越过了它，
  完成后的更新再也读不到。1.4.2 及以前因此漏掉约八成 OpenCode 消息。按 `time_updated` 增量也
  顺带免疫了下面的 rowid 复用问题。水位每轮回看 60 秒：同库可能有多个写入方（并行子 agent、
  多开），时间戳较小的行可能晚提交
- **part 仍按 rowid 水位**：工具块插入时已带 `tool` 名，后续更新不影响采集。但 `part` 随
  `message` `ON DELETE CASCADE`，session 还带 `revert` 列——删掉最大 rowid 后 SQLite 会把该号
  让给下一条插入，新行的 rowid 就可能不大于水位而被静默跳过。故每轮先比 `MAX(rowid)`：表变短
  即说明删过行，水位退回 0 整表重读（dedup 幂等）。残留边界：若"删行"与"插新行"之间一次扫描
  都没发生，缩短信号会被错过，需靠 `SOURCES.version` 自增触发全量重扫补回
- ZCode 的 `model_usage` 只追加、不改行，rowid 水位够用——同为 sqlite 源也不能照抄增量策略，
  先确认那张表会不会删行、会不会原地更新

## 计价：DeepSeek 的峰谷价

单价表 `~/.tokenmeter/pricing.json` 记的是**峰时价**，`off_peak` 为谷时折扣系数（DeepSeek 为 0.5）。

峰时的官方定义（api-docs.deepseek.com/quick_start/pricing，2026-09-16 核对）是 **UTC 周一至周五 01:00-04:00 与 06:00-10:00**，其余一切时段按谷时价。三处反直觉，实现时都踩得到：

- 按 **UTC** 而非本地时区（按"北京时间半夜打折"去猜会大面积算错）
- **整个周末**都是谷时，哪怕落在窗口时刻上
- 两段峰时之间 **04:00-06:00 是空档**，属谷时

判定以 `PEAK_SQL` 片段落地而非 JS 函数，让分组与计价共用同一份定义；费用卡、按天堆叠图、余额对账三处聚合都带上它。`off_peak` 缺失时回落种子表——老用户的 `pricing.json` 里没有这个字段，若实现成"缺失即不打折"，这个规则对他们就是个静默空操作。

## 关键机制

- **增量三策略**：jsonl 字节游标（只推进到完整行尾，写入中的半行下次重读；UTF-8 跨块安全）/ sqlite 水位（只追加的表用 rowid，会原地更新的表用 `time_updated`）/ zst 快照重解析
- **dedup 幂等**：所有事件带全局唯一 dedup_key，重复解析 INSERT OR IGNORE
- **采集器版本号**：`SOURCES.version` 与 `files.state_json._v` 不符 → 自动全量重扫回填（用于采集逻辑升级，如新增工具调用提取）
- **常驻进程版本戳**：collector 必须把 `_v` 写进 state，否则常驻服务每轮全量重扫（真实踩坑）
- **健康自检**：解析错误（红）/ 文件 30 分钟内在写但无新事件（黄，格式漂移静默失败信号）/ 无数据（灰）

## 已验证的对账方法

每源接入后用独立脚本（Python/独立 SQL）对原始文件重算比对，全部精确一致。Codex 的正确口径经"官方面板累计值 vs 本地差分值"交叉验证（差值为官方跨设备统计）。WorkBuddy 积分费率经最小二乘残差验证。

## Antigravity / antigravity-cli：调研结论是**当前不可接入**（2026-09 实测）

Google Antigravity（IDE，`com.google.antigravity` 2.3.1）与 antigravity-cli 都在本机留了数据，
但**逐请求 token 用量没有以任何可解析的形式落地**。逐项证据：

| 位置 | 形态 | 有无用量 |
|---|---|---|
| `~/.gemini/antigravity-cli/conversation_summaries.db` | SQLite，1 张表 | 无。只有 title / step_count / workspace_uris / status 等元数据 |
| `~/.gemini/antigravity-cli/conversations/*.db` | SQLite，per-conversation | `steps`、`gen_metadata` 表存在但为空；载荷列是 protobuf blob |
| `~/.gemini/antigravity-cli/conversations/*.pb` | 二进制，768KB–1.2MB | **熵 8.00 bit/byte、可打印占比 37%、文件头各不相同且无压缩魔数**（非 gzip/zstd/zlib/brotli）→ 加密，非明文 protobuf。密钥在系统钥匙串（日志里有 `keyring.go`） |
| `~/.gemini/*/brain/**/transcript.jsonl` | 可读 JSONL | 无。1628 条记录、112 个键路径里**没有一个**匹配 token/usage/cost/billing；唯一数值叶子是 `step_index` |
| `~/.gemini/*/antigravity_state.pbtxt` | 文本 protobuf | 无。相关字段只有 `last_selected_agent_model` |
| `~/Library/Application Support/Antigravity` | Electron 目录 | 无。`app_storage.json` 为空，Local Storage 里无 token 字样 |

transcript.jsonl 的顶层键是 `step_index / source / type / status / created_at / content /
tool_calls / thinking`——有完整的对话与工具调用，唯独没有 usage。直接 grep 到的 "token"
字样全部来自对话正文（本仓库本身就在讨论 token），不是字段名。

**留一个重要的保留**：实测机器的 CLI 日志反复出现 `You are not logged into Antigravity`，
会话表因此为空；5 月那批 `.pb` 确实是登录期的真实使用，但已加密。所以不能排除
"登录且活跃使用的装机会把用量写到别处"。要复核，在真正用过之后重跑调研：按上表逐个位置
确认，重点看 `conversations/*.db` 的 `gen_metadata`（列名 `data`/`size`，最像放生成元数据的地方）
是否开始有行。

结论：**在拿到可解析的用量来源之前不接**。写一个解析猜测字段的采集器，只会做出一个
永远报 0 却在健康面板显示"正常"的数据源，比不接更有害。

## 不可统计的边界

网页版聊天（ChatGPT/豆包/DeepSeek 网页、Grok Bot 等 Electron 薄壳）：token 计数在服务端，浏览器本地零留痕（实测 IndexedDB 无 usage 字段），且无公开用量 API。除非厂商开放 API 或用户接受浏览器扩展拦截（高维护成本、随改版失效），否则不可覆盖。


## ECharts calendar + custom series 的三个坑（实踩记录，2026-09）

在"GitHub 风格正方形热力图"上连续翻车的根因，贡献者改热力图前必读：

1. **`renderItem` 返回 `roundRect` 会抛空错误**（消息为空字符串，且被 ECharts 吞掉，
   图表整片空白、无 console 线索）——此构建只支持 `rect`；
2. **calendar 同时给定 `top` 与 `bottom` 时，`cellSize` 高度被归一为 `auto`**，
   行距 = 可用高度 ÷ 行数。容器高度必须精确等于 `top + 7×cell + bottom`，
   多 1px 都会被摊进行距导致栅格不对称（同理 `left`+`right` 会拉宽格子）；
3. **custom series 元素的鼠标命中检测不可靠**：`dispatchAction showTip` 正常但真实
   mousemove 不触发。解决：容器监听 mousemove + `convertFromPixel` 反查日期 +
   半格命中校验的自管理 tooltip（见 `bindHeatTooltip`）；
4. **line series 渲染不确定**（同配置时有时无，bar 的生长动画同样会挂起不落帧）——
   逐日密度曲线最终改为**纯 Canvas 手绘**（贝塞尔平滑 + 渐变填充 + 自管理悬停），
   行为完全确定。前端图表遇到玄学空白时优先考虑自绘。

相关回归防护：`test/run.mjs` 的静态断言层（safe() 调用的函数必须存在、DOM id 一致性）
与端到端冒烟层（fixtures 黄金数字、幂等、API 结构）。历史事故：误删 renderLive 导致
整页空白、roundRect 导致热力图消失——均已由测试覆盖。
