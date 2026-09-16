# Token Watcher

**Mac 本地多源 AI Agent 用量与配额实时面板。** 一个常驻进程解析你机器上各 AI 编码工具留下的本地会话记录，统一归一化为 token 事件流，提供 Codex 风格的统计面板、实时配额卡、厂商余额轮询、费用估算与菜单栏胶囊。零框架依赖、纯本地运行。

![Token Watcher](https://raw.githubusercontent.com/luwill/token-watcher/main/docs/screenshot.png)

> 截图为真实运行数据（厂商余额与项目名已脱敏为 ••••）。

## 支持的工具（9 源）

| 工具 | 数据位置 | 能看到什么 |
|---|---|---|
| Claude Code | `~/.claude/projects` | 逐请求 token 明细、模型分布 |
| ccmr（claude-code-model-router） | `~/.claude-gateway/projects` | 同上（国产模型隔离目录，真实模型名） |
| Codex | `~/.codex/sessions`、`archived_sessions` | token 明细、**官方周配额百分比与重置时间**、模型（含 auto-review 子代理）、工具调用 |
| ZCode | `~/.zcode/cli/db/db.sqlite` | 逐请求明细（model_usage 表）、工具调用 |
| dsh（DeepSeek Harness） | `~/.dsh/sessions` | 逐请求明细（zstd 压缩会话） |
| WorkBuddy | `~/.WorkBuddy/projects` | 逐请求明细 + **积分费率自学习**（credit 账本 × token 最小二乘） |
| Grok Build | `~/.grok/sessions` | 轮次用量明细（含厂商侧成本刻度）、工具调用 |
| Pi | `~/.pi/agent/sessions` | 逐请求明细、工具调用（会话 JSONL 自带 USD 成本明细） |
| OpenCode | `~/.local/share/opencode/opencode.db` | 逐请求明细（message 表）、工具调用 |

不支持的：网页版聊天（ChatGPT/豆包/DeepSeek 网页等）——token 计数在服务端，本地无留痕，原理上不可统计。

## 快速开始

```bash
# 方式一：npx 直接运行（推荐，无需克隆仓库）
npx token-watcher serve
open http://127.0.0.1:8787

# 方式二：克隆仓库开发（首扫历史 ~3.3GB 约 6 秒，仅首次）
git clone https://github.com/luwill/token-watcher.git
cd token-watcher && npm install
npm run serve
```

要求：**Node ≥ 22.13**（`node:sqlite` 自该版本起免 `--experimental-sqlite` flag，零原生依赖）。dsh 源需要解 zstd：Node ≥ 23.8 用内置实现，更早的版本回落到系统 `zstd`（`brew install zstd`），两者都没有时自动跳过该源。

平台支持：**macOS 全功能验证**（含菜单栏 App 与 launchd）。Windows / Linux 上核心链路（采集、面板、API）随 CI 在 macOS + Ubuntu + Windows 三平台跑回归，包含"装成依赖后能否真正跑起来"的安装冒烟。菜单栏 App 与 launchd 开机自启为 macOS 专属；dsh 源在 Node ≥ 23.8 上用内置 zstd，更早版本需系统 `zstd`（Windows 上一般没有，会自动跳过）。

开发与测试：`npm test` 运行五层回归——语法检查、import 冒烟（拦模块级错误，`node --check` 看不见）、静态断言、前端纯函数行为、端到端冒烟（fixtures 黄金数字 + 幂等 + API 结构）。零依赖、离线运行，GitHub Actions 上跑 macOS/Ubuntu × Node 22.13/24 矩阵。

其他命令：

```bash
tokenwatcher today       # 终端速览今日消耗
tokenwatcher scan        # 只扫描一次
tokenwatcher serve --port 9000
npm run install-agent  # launchd 开机自启（KeepAlive 崩溃自拉起）
npm run bar            # macOS 菜单栏胶囊（需 npm run build-bar 编译）
```

## 功能

- **实时**：FSEvents 监听各数据目录 → 增量解析 → SSE 推送，面板秒级刷新（实测 <1s）
- **增量采集**：字节级游标 / rowid 水位 / 快照重解析三种策略，二次扫描 0ms；dedup 键保证幂等；采集器版本号机制支持逻辑升级后自动全量回填
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

## License

[MIT](LICENSE)
