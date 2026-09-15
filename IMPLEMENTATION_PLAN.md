# 实施计划：评审阶段 1（止血）

来源：`docs/REVIEW-2026-09-15.md`。目标是修掉"服务会悄悄死掉"与"面板在撒谎"两类问题，
不做结构重构（那是阶段 2）。

## 测试落点（seam）

| seam | 测什么 |
|---|---|
| `Scanner.scanAll()` | 源文件被删除后不抛异常、陈旧游标行被清理、事件不受影响 |
| `Store` 构造 | `busy_timeout` 已生效 |
| `computeRecon()` | 美元计价厂商的对账花费不再恒为 0 |
| HTTP API（真实 serve） | 伪造 Host 被拒；路由异常返回 500 而非进程退出 |
| `BalancePoller`（注入 fetch/envPath） | 连续 4xx 后熔断，不再每轮请求 |
| `esc()`（前端纯函数） | 文本与属性上下文的转义行为 |

## 阶段

### 1. 进程健壮性 — ✅ 完成
- [x] H1 `stat` 移入容错路径；ENOENT 视为"文件已删"跳过
- [x] H1 陈旧 `files` 游标行清理（仅清理所属 root 当前存在的路径）
- [x] H1 `scanning` 标志改 `finally` 复位（异常后不再永久卡住扫描）
- [x] H1 `_scheduleScan` 捕获异常；serve 分支装进程级兜底（scan/today 仍大声失败）
- [x] H6 路由统一错误处理 `withErrors`
- [x] H6 `PRAGMA busy_timeout = 5000`

### 2. 数据正确性 — ✅ 完成
- [x] H2 对账复用 `priceOf()`（美元按汇率折算 + LiteLLM 兜底）；`PROVIDER_PREFIX` 补 glm
- [x] H2 `buildSummary` 先算 costs，再把同一汇率传给对账（两张卡不再各说各话）
- [x] H3 会话钻取曲线改 `trigger:'axis'`（`symbol:'none'` 无图元可命中）

### 3. 运行环境与外部依赖 — ✅ 完成
- [x] H4 `engines.node` 提到 `>=22.13`
- [x] H4 `--no-warnings` 收窄为 `--disable-warning=ExperimentalWarning`
- [x] H5 余额轮询熔断：连续 4xx / 结构不认识停用至重启，网络抖动不计入
- [x] H5 熔断状态进 `/api/summary`，健康条显示停用原因

### 4. Web 安全与容错 — ✅ 完成
- [x] M1 Host 头校验（非本机返回 403，防 DNS rebinding）
- [x] M2 `esc()` 统一转义所有 `innerHTML` 插值与图表 formatter
- [x] M9 `load()` 失败显示错误横幅，不再静默停在旧数据

### 5. 验证 — ✅ 完成
- [x] `npm test` 全绿（新增 22 条断言）
- [x] 真实库 `scan`：退出码 0，陈旧游标 40 → 0，事件 72,108 条完整保留
- [x] 重启常驻服务后端到端验证：伪造 Host 403、本机 200、对账 −3.25 vs 3.20 对上

---

# 阶段 2（结构）

### 6. 发布物与仓库卫生 — ✅ 完成
- [x] M6 `package.json` 加 `files` 白名单：npm 包 1.1 MB → 61.7 kB（28 个文件）
- [x] M6 `.gitignore` 改掉旧名 `bin/token-stats-bar` → `bin/token-watcher-bin`
- [ ] M6 已提交的两份 180 KB Mach-O 需 `git rm --cached`（会改动索引，留到提交时一并做）

### 7. 离线模式 — ✅ 完成
- [x] `TOKENMETER_OFFLINE=1`：跳过汇率、LiteLLM 牌价、厂商余额三类外网请求
- [x] fx 退回磁盘缓存/兜底值，litellm 只读缓存，balance 完全不轮询
- [x] `/api/summary` 增加 `offline` 字段
- [x] 回归测试改为离线运行：不再依赖公网，耗时从数秒降到 635 ms

### 8. 前端拆 ES 模块 — ✅ 完成
- [x] `web/lib/format.js`（esc/fmt/fmtShort/hhmm/ymd）
- [x] `web/lib/theme.js`（工具色、8 槽色板、热力图色阶）
- [x] `web/lib/series.js`（pickSeries/assignSlots/stackTipFormatter/dayAxis/fillDays）
- [x] `web/lib/tooltip.js`（挂载点与视口夹取，视口可注入以便测试）
- [x] `app.js` 911 → 779 行；`index.html` 改 `<script type="module">`
- [x] 测试层 2b 由"正则抽源码 + data: URL 求值"改为**直接 import 真实模块**
- [x] 新增真实行为断言：视口夹取几何、悬浮框转义、ymd 本地时区、fmt 分档
- [ ] 图表/面板渲染函数仍在 app.js（charts/、panels/ 拆分留待后续）

### 9. 测试与 CI — ✅ 完成
- [x] 新增 `[1b] import 冒烟`：`node --check` 看不见模块图，而线上 12 次崩溃全是缺失导出/
      只读属性赋值这类模块级错误
- [x] `.github/workflows/test.yml`：macOS + Ubuntu × Node 22.13 / 24 矩阵，外加 import 冒烟
- [x] 断言 78 → 186 条

### 10. 浏览器实测 — ✅ 完成
- [x] 模块图加载正常：`__renderErr` 为空、7 张图均有真实像素、SSE 连接、6 张状态卡
- [x] H3 复验：会话曲线悬浮框真的弹出了（「合计 3.2 万 输入 2K · 缓存 29K · 输出 204」）
- [x] 静态资源路径穿越仍被挡（`/lib/../../package.json` → 404）

## 未提交

改动已全部落盘并通过测试，但**尚未提交**（当前在 `main` 分支）。
建议先开分支，再按阶段拆提交；提交时一并 `git rm --cached` 两份二进制。

## 下一步

- **M3** 路径无关的 dedup 键 + 迁移（Codex 归档搬移会导致重复计数）——涉及对真实库的
  `UPDATE`，按仓库约定需先征得确认
- **M7** 汇总查询缓存、**M8** Codex 模型继承频次（性能）
- **M12** 健康自检 `stale` 误报（本轮实测发现，判据应改为"有含 usage 的新行却没产出事件"）
- 后端路由拆分与单一事实源（`computeHealth` 改为遍历 `SOURCES`）
- 产品侧 P0：订阅 ROI 面板、配置化、项目维度
