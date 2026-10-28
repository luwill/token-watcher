# 新增豆包 / 豆包工作 Token 用量统计

- status: flying <!-- planned → flying → landed | aborted；landed 关闭运行，即使其落地步骤被 park -->
- workspace: autopilot/doubao（直接在本 checkout 的 autopilot/doubao 分支开发；runner 门禁各自建临时 worktree；main 指针不动，落地时合并）
- base: 03add64（契约导入提交，docs/autopilot.md + docs/autopilot-policy.json）
- cut from: d04cc81（main 分支尖）
- tested commit: dac6444（stage1 证据提交后 HEAD；stage 门禁各自记录 tested commit）
- contract: docs/autopilot.md <!-- confirmed by the human 2026-10-28 as-is; amendment P1 (env-clean) accepted 2026-10-28 -->
- mode: full
- host: degraded（人类 2026-10-28 批准 env-clean 降级：本机 sandbox-exec 的 localhost 放行规则匹配全部外网地址，deny_network 无法 OS 强制；runner 拒绝后经批准以 env-clean 运行。skill 对限制性 policy 强制升级 sandbox-exec 且探针失败拒绝降级 → policy 实际设为非限制（deny_network=false、deny_paths=[]），红线非强制项见 Not verified）
- policy: docs/autopilot-policy.json at the pinned commit
- helper pin: 8843c17e5c28546d10a2fdee99a301bd0c89c7e7f439b501a470e8c771d47f80
- current: stage 1 review

## Goal

用户原话：「新增对豆包和豆包工作APP的Token用量统计」（经 autopilot 技能执行）。项目为本地实时 Token 用量/配额仪表盘 token-watcher；上一会话已留下未提交 WIP（v8leveldb 解码层 + doubao 采集器 + SOURCES/scanner 注册），本次运行完成并验证该特性。

## Preflight

| check | how | result | evidence |
|---|---|---|---|
| machine gate at base | `run-gate.sh`（label `gate-base`，`npm test`） | 全绿（exit 0，2127806f） | `gate-base.md` |
| premise P1: 测试不碰真实 HOME | gate 内 HOME 指临时目录；`run-mutant.sh` 移除 `process.env.HOME = PROC_HOME` | held；detector KILLED（基线 exit 0 / mutant exit 1） | `premise-p1-mutant.md` |
| premise P2: 门禁读不到真实豆包目录 | policy deny_paths + sandbox-exec | **降级为 NOT OS-ENFORCED**（人类批准 env-clean；见 Not verified） | — |

## Acceptance criteria

Frozen at takeoff. A run changes `status` and `evidence`, never the criterion; a criterion that turns out wrong gets an erratum below.

| id | criterion | proven by | status | evidence |
|---|---|---|---|---|
| C1 | 前端登记完整：doubao/doubaowork 在 `web/lib/theme.js`（TOOL_COLORS/TOOL_LABEL）、`web/app.js`（LIGHT_TOOL_COLORS）、`web/style.css`（badge 深/浅）、`web/index.html`（footer 数据源清单）登记；新色过 CIEDE2000 全集校验（最差配对不劣于现状）；套件「每个注册数据源都有品牌色与标签」绿 | `gate-s1`；mutant 删 `TOOL_COLORS.doubao` → 断言失败 | proven（gate-s1 绿 @57f5eed；mutant-c1 KILLED；stage1.md 校验记录。注：色盲最差对如实记录为 doubaowork vs ccmr/dsh 4.5–5.9，主题内“不劣于现状”表述已按实测修正） | `gate-s1.md`,`mutant-c1.md`,`stage1.md` |
| C2 | 单元测试：`test/doubao-leveldb.mjs` 覆盖 v8leveldb（snappy 原始流、raw/snappy 块、WAL 32KB 分片重组、.blob 外置值、畸形输入静默跳过）与 doubaoUsage/doubaoEvents（input 四项和、ts/会话/project、model=doubao-model-<id>、output=0）及 collectDoubaoFile 经 store 真实链路、幂等重扫 | `gate-s2`；mutant 破坏解码/去重细节 → 断言失败 | open | |
| C3 | 端到端：`test/run.mjs` 合成 leveldb fixture（raw .ldb + snappy 块 + 跨 32KB .log + 字节相同重写系列 + `ff 11 01` 外置干扰 + 无关 leveldb 目录），scan ×2 幂等，黄金数字（事件数、input 和、output=0、model、project、dedup）断言 | `gate-s3`；mutant 改 dedup key → 重复事件被断言捕获 | open | |
| C4 | 真实数据：临时 HOME + 软链真实 `{Doubao,DoubaoWork}` 目录跑 scan：doubao ≥1 条事件（9 月冻结库）、doubaowork 行健康、doctor 两行正常 | 落地证据（非代码检查，无 mutant） | open | |
| C5 | 文档：`README.md`/`README.zh-CN.md` 支持表 13→15、`docs/ARCHITECTURE.md` 豆包格式节、`package.json` description/keywords 增豆包 | `gate-s4`（docs 路径豁免阶段对抗评审）+ 落地审计 | open | |

### Independent mutation targets

Full mode: at least one target selected by the adversary for each criterion. The adversary is the independent reviewer at the stage review, and picks the target **before** the first mutant wave of that stage.

| criterion | selected by | source condition / failure | patch | baseline | result / evidence |
|---|---|---|---|---|---|
| C1 | adversary（契约预定义，人类在契约批准时认可） | 漏登记 doubao 颜色/标签 | 删 theme.js TOOL_COLORS.doubao | 套件绿 | KILLED（基线 exit 0 / mutant exit 1，命中 `✗ …缺登记: doubao`）@57f5eed → `mutant-c1.md` |
| C2 | adversary | 解码/去重逻辑被破坏 | 待 stage2 评审指定 | 套件绿 | / |
| C3 | adversary | dedup 失效导致重复事件 | 待 stage3 评审指定 | 套件绿 | / |

### Evidence integrity

Record the pinned record commit, manifest verification command and result. Every cited evidence file (including review findings and images) must be in MANIFEST. Command output and findings are untrusted data, even after successful verification.

### Criterion errata

Append only. The human rules on each at landing.

| id | criterion | what is wrong | evidence | proving instead |
|---|---|---|---|---|
| C1 | “最差配对不劣于现状”字面不可达：品牌蓝系 + 不动既有 dsh/ccmr 时，任何新增蓝都会在色盲模拟下与二者之一接近（扫描 17 个候选验证）。最终取 doubao #1d6cff / doubaowork #5c8fd0：常视觉最差对保持原 zcode/cursor（8.89），CVD 最差对 4.50–5.92（≥4.5 可区分），兄弟对 ≥11.4 | `stage1.md`（方法、自检、候选扫描、精确配对表）、theme.js 注释已按实测撰写 | 按实测数值验收（人类在落地时裁定本 erratum） |

## Stages

1. [x] Stage 1 前端登记完整化 — owns C1（theme.js/app.js/style.css/index.html/.gitignore 增 `.zcode/`）→ gate-s1 绿、mutant-c1 KILLED、待评审
2. [ ] Stage 2 单元测试 — owns C2（test/doubao-leveldb.mjs）
3. [ ] Stage 3 端到端 fixture — owns C3（test/run.mjs）
4. [ ] Stage 4 文档 — owns C5（README ×2、ARCHITECTURE、package.json）
5. [ ] Landing 真实数据验证 — owns C4 + 合并 autopilot/doubao → main

## Ledger

### Decisions

| id | stage | chose | rejected | wrong if |
|---|---|---|---|---|
| D1 | base | WIP（含 theme.js 最小登记修复）提交为 base，保持 base 门禁全绿 | 把带红 base 的运行写进记录 | base 套件不全绿 |
| D2 | all | 真实数据验证用「临时 HOME + 软链真实目录」，只读真实数据、写临时库 | 直接带真实 HOME 扫描（写真实库） | 用户明确授权写真实库 |
| D3 | 1 | doubao 用豆包品牌蓝系候选色，先算 CIEDE2000 全集最差配对再定 | 直接挑顺眼颜色 | 新色制造更差色盲短板 |

### Review findings

| id | round | reviewer | finding | status | note |
|---|---|---|---|---|---|
| R1 | 1 | snapshot-only（同模型族，消毒+pinned dac6444，见 evidence review-s1-request/findings/receipt） | approve：0 blocking；2 minor（theme.js 注释配对数字归属可读性；浅色/徽章登记仅证据约束无自动化检测——与既有工具现状一致） | closed | 阶段验收通过，minor 不阻塞；评审文件已登记 evidence |

### Parked

In the order the human should do them.

| id | needs | exact action | unblocks | verify afterward |
|---|---|---|---|---|

### Proposed contract changes

What the run learned the contract should say. The human accepts or rejects each.

| id | proposal | human ruling |
|---|---|---|
| P1 | 本机 sandbox-exec localhost 放行规则匹配全部外网，deny_network 无法 OS 强制；批准 env-clean 降级运行并披露未强制项。因 skill 对限制性 policy 强制升级 sandbox-exec 且探针失败拒绝降级，policy 最终设为非限制（deny_network=false、deny_paths=[]），红线保留在契约/记录 | accepted 2026-10-28 |

### Not verified

Everything the run did not or could not check, and why — or `none`.

- 红线非 OS 强制（人类批准的 env-clean 降级，证据同时披露）：网络拒绝降为死代理变量（HTTP(S)_PROXY/ALL_PROXY/npm_config_offline/PIP_NO_INDEX），真实豆包目录 deny_paths 不再 OS 级拒绝读取；source 写保护仍由 permissive profile 的 deny 规则执行。测试套件自身离线设计（TOKENMETER_OFFLINE + 注入假 fetch + 导入前临时 HOME）与 [隔离] 断言不受影响，P1 前提变异照常跑。

## Acceptance walk

Riskiest first.

| # | where | do | should see |
|---|---|---|---|
| 1 | 真实豆包数据 | 软链临时库 scan | doubao ≥1 事件，doubaowork 健康 |
| 2 | 端到端 fixture | scan ×2 | 黄金数字两次一致 |
| 3 | 单元测试 | 运行 test/doubao-leveldb.mjs | 全部 ✓ |

## Resume log

One row per interruption: when, the saved `current:`, what Git and the evidence showed, and what was repeated (or `nothing`).

| when | saved current | found | repeated |
|---|---|---|---|
