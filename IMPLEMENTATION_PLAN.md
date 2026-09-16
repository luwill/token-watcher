# 实施计划：新增 Pi 与 OpenCode 两个统计来源

目标：把本机已有真实数据的 Pi（`~/.pi`）与 OpenCode（`~/.local/share/opencode`）接成
一等数据源，口径与既有七源一致，不引入"永远报 0 却显示正常"的假数据源。

## 接入前的可行性判定（已完成，实测 2026-09-16）

沿用 Antigravity 那次的判定标准：**逐请求用量必须以可解析形式落地**，否则不接。

| 源 | 位置 | 形态 | 逐请求用量 |
|---|---|---|---|
| Pi | `~/.pi/agent/sessions/<编码cwd>/<时间>_<uuid>.jsonl` | 追加式 JSONL | ✅ `message.usage`：input/output/cacheRead/cacheWrite/reasoning + **USD 成本明细** |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite（WAL） | ✅ `message.data.tokens`：total/input/output/reasoning/cache.{read,write} |

**口径实测**（独立重算，见"阶段 5"）：两源均为
`total = input + output + cacheRead + cacheWrite`，即 **input 不含缓存**、
**reasoning 已含在 output 内**。这与库内 `total_tokens = input_tokens + cached_input +
cache_write + output_tokens` 完全同构，无需新增列或特殊分支。

## 测试落点（seam）

| seam | 测什么 |
|---|---|
| `collectPiFile()`（经 CLI 真实扫描） | usage 黄金数字；同 id 重复行 dedup；`session` 行的 cwd → project 并跨增量扫描保持 |
| `collectOpencodeDb()`（同上） | rowid 水位增量；`session.directory` → project；tool part → tool_calls |
| `SOURCES` / `computeHealth()` | 健康列表长度随注册表增长（消除 server.js 里的硬编码工具表） |
| `TOOL_COLORS` / `TOOL_LABEL` | 每个注册源都有配色与标签（拦"加源忘了登记前端"） |

## 阶段

### 1. Pi 采集器 — ✅ 完成
- [x] 先写失败测试：fixture + 黄金数字 + dedup + project 捕获
- [x] `src/collectors/pi.js`：按字节游标解析；`type=message` 且 `message.usage`
- [x] project 来自首行 `type=session` 的 `cwd`，存入 collector state 供增量轮次复用
- [x] `toolCall` 内容块 → `tool_calls`

### 2. OpenCode 采集器 — ✅ 完成
- [x] 先写失败测试：sqlite fixture + 黄金数字 + 水位增量 + tool part
- [x] `src/collectors/opencode.js`：`message` 表 rowid 水位；`part` 表独立水位
- [x] 多候选根：`XDG_DATA_HOME` / `~/.local/share` / `LOCALAPPDATA`（实测自可执行体字符串）

### 3. 注册与前端登记 — ✅ 完成
- [x] `config.js` SOURCES + `scanner.js` COLLECTORS
- [x] `server.js` 健康工具表改为从 SOURCES 推导（当前硬编码，加源必漏）
- [x] `web/lib/theme.js` 配色与标签、`web/style.css` 徽章

### 4. 文档 — ✅ 完成
- [x] `README.md` 源表（7 源 → 9 源）
- [x] `docs/ARCHITECTURE.md` 两源格式笔记与口径说明

### 5. 真实数据校验 — ✅ 完成
- [x] 独立脚本对原始文件重算，与库内聚合逐项比对（本项目接每个源的惯例）
- [x] 全量 `npm test` 通过

## 校验记录（2026-09-16，隔离 HOME + 符号链接指向真实数据目录，未触碰正式库）

| | 原始文件独立重算 | 库内 | 差异 |
|---|---|---|---|
| Pi 条数 | 96 | 96 | 0 缺 / 0 多 / 0 数值不一致 |
| Pi token 合计 | 5,144,845 | 5,144,845 | 0 |
| OpenCode 条数 | 3 | 3 | 0 |
| OpenCode token 合计 | 48,007 | 48,007 | 0（等于其 session 表自报聚合） |

- 原始 97 条 usage 记录中有 1 条用量全为 0（空调用/中断），按 `total <= 0` 跳过，与 Grok/ZCode 一致
- 二次扫描 `+0 events`，幂等
- 健康自检 9 行，pi/opencode 均为 ok；`unpriced` 如实列出 `mimo-v2.5-free` 与
  `deepseek/deepseek-v4-flash-0731`（OpenRouter 通路，与直连不同价，故不做前缀合并）

## 过程中发现并修掉的两个隐患

1. `server.js` 的健康工具表是**手抄的硬编码清单**，与 `SOURCES` 重复——加源必漏，
   且漏掉的源不会报错，只是从健康自检里静默消失。已改为从注册表推导，并加断言守住。
2. OpenCode 的 `message`/`part` 是 `ON DELETE CASCADE`（session 还带 `revert`），
   **会删行**；SQLite 删掉最大 rowid 后会复用该号，纯 rowid 水位会漏掉复用号的新消息。
   已加"表变短即退回 0 重读"的防护，并有会真红的回归用例。
