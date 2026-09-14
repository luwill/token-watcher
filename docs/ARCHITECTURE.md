# TokenMeter 架构与数据源调研

> 本文档源自真实环境的逆向调研（2026-09），记录各数据源的本地格式、口径差异与设计决策。不含任何个人数据。

## 总体架构

```
bin/tokenmeter.js        CLI（scan / serve / today）+ 一次性目录迁移
src/
  config.js              数据源注册表（kind + collector + version）
  store.js               SQLite（node:sqlite）：events / files游标 / quota / rates / tool_calls / balance_history
  scanner.js             按源类型枚举 + 增量扫描 + FSEvents + 版本回填 + resume链模型继承
  server.js              HTTP API + SSE + 健康计算 + Claude 5h 推算 + 每日备份
  balance.js             厂商余额轮询（DeepSeek/Kimi）
  pricing.js             ccmr 费用折算 + 余额对账
  rates.js               WorkBuddy 积分费率自学习（最小二乘）
  models.js              模型名归一化（跨源大小写合并）
  collectors/            每源一个适配器
web/                     零构建前端（vanilla JS + ECharts UMD）
menubar/                 macOS 菜单栏 App（Swift/AppKit，需 .app bundle）
~/.tokenmeter/           运行时数据（库 / 备份 / pricing.json / 日志）
```

## 归一化事件模型

`(ts, tool, model, session_id, project, input_tokens[不含缓存], cached_input, cache_write, output_tokens, reasoning_tokens, total_tokens, trace_id, dedup_key UNIQUE)`

**口径**：Anthropic 系（Claude Code/ccmr/dsh）`input_tokens` 不含缓存，total = 四项之和；OpenAI 系（Codex/ZCode/WorkBuddy/Grok）input 已含 cached，入库拆为 新输入/缓存命中 两列。total = input + cache_write + output。

## 数据源格式笔记

### Claude Code / ccmr（同一解析器）
`~/.claude/projects/<项目目录>/<会话>.jsonl`，ccmr 用独立 `CLAUDE_CONFIG_DIR=~/.claude-gateway` 同格式。每条 type=assistant 记录的 `message.usage` 即一次 API 调用；`model="<synthetic>"` 为本地合成消息须过滤；同一 message.id+requestId 会因流式分片重复出现 → 全局 dedup。工具调用在 content[] 的 tool_use 块。

### Codex（坑最多）
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`：
- `token_count.info.total_token_usage` 是**会话累计值**，按相邻事件差分取单次用量；差分 0 的重复通知自然跳过
- **resume/fork 会话继承父线程累计基线**——若直接对"每文件终值"求和会把同一对话重复计数（实测差 9 倍），差分 + 首事件建基线天然正确
- 模型名版本漂移：新格式在 `thread_settings_applied.thread_settings.model`，旧格式在 `turn_context.payload.model`；续写文件两者皆无 → 按 `session_meta.parent_thread_id` 继承链回填（dedup 只防重插不更新旧行，需显式 UPDATE）
- `rate_limits` 为账号级配额快照（used_percent/window/resets_at），只保留全局最新（按 ts，与扫描顺序无关）
- 工具调用在 `response_item` 且 `payload.type=function_call`（name/call_id）
- `codex-auto-review` 是 Codex Desktop 内置自动审查子代理的模型槽位，真实用量

### ZCode
`~/.zcode/cli/db/db.sqlite`（WAL，可只读并发）：`model_usage` 表逐请求明细（rowid 水位增量；实测 computed_total=input+output 推得 input 含 cached）；`tool_usage` 表逐工具调用；`session.directory` 取项目名。**WAL 写入不改变主文件 mtime**——mtime 跳过判断对 sqlite 源无效，须每轮执行水位查询（微秒级）。

### dsh
`~/.dsh/sessions/**/session.jsonl.zstd`（zstd 压缩，快照式：mtime 变化整体重解析 + dedup）。usage 在 `assistant/chunk` 记录的 `data.chunk.usage`（Anthropic 口径）；模型来自 `request/header.config.model`；cwd 在 `session` 记录。会话文件全同名，以父目录为会话键。

### WorkBuddy
`~/.WorkBuddy/projects/<目录>/<会话>.jsonl`（Electron 版 transcript）：`message.usage`（input 含 cache）；`providerData` 携带真实模型名（sessions 表的 model 列只是别名如 fast-model）与 traceId。
- `workbuddy.db.session_usage` 是上下文水位表（used=最近请求 input_tokens，非累计）
- `credit_json` 键 = 轮次 traceId、值 = 该轮积分消耗 → 与事件表按 trace_id 连接可**经验性标定积分费率**（纯单模型轮次无截距最小二乘，实测残差≈两位小数舍入）；混合轮次与 <3 样本不参与
- SQLite 为 WAL 写入，transcript 与水位表同秒落盘

### Grok Build
`~/.grok/sessions/<URL编码项目目录>/<会话id>/updates.jsonl`：`turn_completed.usage` 带全量明细（含 cachedRead/reasoning/modelCalls/costUsdTicks 厂商成本刻度）与 `modelUsage` 逐模型拆分；timestamp 为 Unix 秒。工具调用在 `tool_call` 事件（title/kind）。注意 `_meta.totalTokens` 是会话上下文水位而非轮次用量，勿用。

## 关键机制

- **增量三策略**：jsonl 字节游标（只推进到完整行尾，写入中的半行下次重读；UTF-8 跨块安全）/ sqlite rowid 水位 / zst 快照重解析
- **dedup 幂等**：所有事件带全局唯一 dedup_key，重复解析 INSERT OR IGNORE
- **采集器版本号**：`SOURCES.version` 与 `files.state_json._v` 不符 → 自动全量重扫回填（用于采集逻辑升级，如新增工具调用提取）
- **常驻进程版本戳**：collector 必须把 `_v` 写进 state，否则常驻服务每轮全量重扫（真实踩坑）
- **健康自检**：解析错误（红）/ 文件 30 分钟内在写但无新事件（黄，格式漂移静默失败信号）/ 无数据（灰）

## 已验证的对账方法

每源接入后用独立脚本（Python/独立 SQL）对原始文件重算比对，全部精确一致。Codex 的正确口径经"官方面板累计值 vs 本地差分值"交叉验证（差值为官方跨设备统计）。WorkBuddy 积分费率经最小二乘残差验证。

## 不可统计的边界

网页版聊天（ChatGPT/豆包/DeepSeek 网页、Grok Bot 等 Electron 薄壳）：token 计数在服务端，浏览器本地零留痕（实测 IndexedDB 无 usage 字段），且无公开用量 API。除非厂商开放 API 或用户接受浏览器扩展拦截（高维护成本、随改版失效），否则不可覆盖。
