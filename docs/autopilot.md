# Autopilot contract — token-watcher (token-stats)

Standing rules for unattended runs (the `autopilot` skill). The human owns this file: a run reads it and never edits it; it records the human's confirmation in its run record and proposes changes there.

Status: in force since 2026-10-28 (human confirmed the proposed draft as-is)

## Workspace

每次运行从 main 开新分支 `autopilot/<slug>`，在该分支的独立 worktree 中执行；main 保持不动。本机 8787 面板服务由用户手动 `npm run serve` 启动，不随 main checkout 运行，分支切换不影响它。本次运行已存在的未提交 WIP（豆包采集器：`src/config.js`、`src/scanner.js`、`src/collectors/doubao.js`、`src/v8leveldb.js`）提交为该分支的 run base，绝不丢弃。

## Preflight

| check | command | ready when |
|---|---|---|
| 工具链与沙箱 | `bash <skill>/scripts/host-doctor.sh <repo>` | 推荐 strict（sandbox-exec 可启动） |
| base 门禁 | `run-gate.sh`（label `gate-base`，命令 `npm test`） | 全绿，含 [隔离] 前提检查 |
| 前提 P1（测试不碰真实 HOME） | gate 内 HOME 指向临时目录；`run-mutant.sh` 移除 HOME 重定向 | held；mutant KILLED |
| 前提 P2（门禁读不到真实豆包目录） | policy deny_paths + sandbox-exec；runner 生成 canary 探针 | 沙箱内读被拒、沙箱外正控可读 |

## Safety premises

| premise | how a run attempts it | holds when |
|---|---|---|
| P1 测试进程从不读写真实 HOME 数据 | run.mjs 在导入 config.js 前把 HOME/USERPROFILE/XDG_* 全部指进临时目录，尾部 [隔离] 断言进程内解析出的每条路径（DATA_DIR/DB_PATH/全部 SOURCES roots）都落在临时目录下 | gate 绿；移除 `process.env.HOME = PROC_HOME` 的 mutant 令 [隔离] 断言失败（KILLED） |
| P2 门禁读不到真实豆包数据目录 | policy `deny_paths` 列出 `~/Library/Application Support/{Doubao,DoubaoWork}`；`deny_network` 触发 sandbox-exec 严格模式 | preflight 探针：沙箱内读取被拒 |

## Machine gate

| command | proves | rerun |
|---|---|---|
| `npm test`（离线、临时 HOME；run.mjs 自身注入假 fetch） | 全量回归套件绿，含 doubao 单元/端到端用例、[隔离] 前提与颜色/标签登记交叉检查 | safe |
| `git diff --check <base>..HEAD -- . ':!docs/evidence' ':!docs/runs'` | 无空白错误 | safe |

Gate settings：

- `GATE_TIMEOUT`: 3600（秒/命令）
- `GATE_KEEP_REGEX`: `✓ 全部通过|✗ [0-9]+ 项失败|PASS .*`
- `GATE_ENV`: 空（run.mjs 自行设置 TOKENMETER_OFFLINE/TOKENMETER_NO_KEYCHAIN 与临时基目录）
- `GATE_SETUP` / `MUTANT_SETUP`: 无（node_modules 由 policy `share_dirs` 只读链接进 worktree）
- `REDACT_REGEX`: 无
- `GATE_SANDBOX`: 按 policy（env-clean 模式；macOS 下仍经 sandbox-exec + permissive profile，source 写保护由 profile deny 执行，网络/路径红线不强制）
- `MUTANT_FAILURE_REGEX` / `MUTANT_FAILURE_EXIT`: 每条目标断言单独冻结（例：`✗ 每个注册数据源都有品牌色与标签.*缺登记: doubao` / exit 1），缺失或错配不得判 KILLED
- `GATE_RERUN_POLICY=safe`（套件用临时目录与随机端口，可安全重跑）
- 工具链：node/npm/python3 位于 sandbox_runtime base（见 policy `read_paths`）；git/perl/jq 系统自带

Host setup：不允许修改本机（不跑 `host-doctor.sh --fix`）。**契约修正（人类 2026-10-28 批准）**：本机 macOS 的 sandbox-exec 有缺陷——`(allow network* (remote ip "localhost:*"))` 会匹配任意外部地址，`allow_loopback` 等效放行全部网络，`deny_network` 无法 OS 级强制；runner 预检按设计拒绝（exit 77）。人类批准以 env-clean 模式运行。skill 的实现对任何限制性 policy（有 deny_network/deny_paths）都强制升级 sandbox-exec 严格 profile，且"能启动但探针失败的后端拒绝降级"——因此 policy 实际设为非限制（deny_network=false、deny_paths=[]），有效 sandbox=env-clean。**红线仍在本契约中生效（行为规则），但本机 NOT OS-ENFORCED**：网络拒绝降为死代理变量、真实豆包目录不设 OS 级读取拒绝；source 写保护由 permissive profile 的 deny 规则执行；测试套件自身隔离（临时 HOME + TOKENMETER_OFFLINE + 注入假 fetch + [隔离] 断言）不受影响。以上披露同时记入运行记录 Not verified。

## Execution policy (required companion file)

`docs/autopilot-policy.json` 随本契约一并提交：

- `sandbox: env-clean`；因本机 sandbox-exec 缺陷（人类 2026-10-28 批准，见 Host setup），policy 为非限制（`deny_network: false`、`deny_paths: []`）→ 有效 sandbox=env-clean：permissive profile + endpoint 源校验；网络与真实目录红线 NOT OS-ENFORCED，证据披露
- `allow_loopback: true`：测试在 localhost 起临时 HTTP 服务
- `read_paths`: sandbox_runtime base（node/npm/python3 所在），扩展现有系统运行时可读白名单
- `share_dirs: ["node_modules"]`：已装依赖，从 checkout 只读链接进每个 worktree
- `record_paths`: evidence_dir=`docs/evidence`，run_record=`docs/runs/run.md`
- `write_dirs`: 无（测试写 HOME/TMPDIR 即可）

## Pre-authorized

- 在 `autopilot/doubao` 分支内自由提交（WIP base 提交、阶段提交、`autopilot: ...` 记录提交）。
- 落地步骤（执行前须对应验收标准以当前证据 proven 且无关联 blocker/dispute/blocking fixed-unreviewed）：
  1. 真实数据验证（只读真实数据）：临时 HOME 下把真实 `~/Library/Application Support/{Doubao,DoubaoWork}` 软链进 `$TMPHOME/Library/Application Support/`，跑 `node bin/tokenwatcher.js scan` + `doctor`；断言 doubao ≥1 条事件、doubaowork 行健康；写入的是临时库，不碰真实库。
  2. 合并 `autopilot/doubao` → main。
- 真实 ~/.tokenmeter 库导入（带真实 HOME 跑一次 scan）：**不预授权**；须人类在本次确认或落地时单独批准。

## Red lines

| red line | prepare instead |
|---|---|
| 门禁期间不读写真实豆包数据目录（本机 NOT OS-ENFORCED，行为红线） | 一切测试用合成 fixture；真实数据只在落地步骤经批准后用软链临时库方式读取；不设 OS 级拒绝（env-clean 披露） |
| 门禁期间不联网（本机 NOT OS-ENFORCED，行为红线） | 离线测试（TOKENMETER_OFFLINE + 注入假 fetch + 死代理变量） |
| 修改本机系统/安装软件（host-doctor --fix） | park |
| 发布（npm publish / 打 tag / 推送远端） | park，保留分支 |
| 写真实 ~/.tokenmeter 数据库 | park，待人类授权 |
| 删除/覆盖用户已有文件（含 `.zcode/` 计划） | 保留不动；只在 .gitignore 登记 `.zcode/`（新增一行，不删文件） |

## Evidence

证据目录 `docs/evidence`：独立目录、只放证据，每个文件 `<label>.md`（`gate-s1`、`mutant-c1`、`gate-landing` 等），一标签一结果、绝不覆盖，各记录其 tested commit；检查产出文件（截图等）以 `<label>-<name>.<ext>` 放旁边。mutant 补丁放 `.git/autopilot/`，证据内嵌。证据文件连同完整 SHA-256 `MANIFEST` 一起提交；评审者先用 `verify-evidence.sh` 核对 pinned MANIFEST。新证据目录 `docs/evidence`、`docs/runs` 不被 .gitignore 吞掉。历史 docs 文档不登记 MANIFEST、不豁免源码检查。

## Review

- Boundary：本机无 codex CLI、无 REVIEW_API key → 批准 snapshot-only fallback：独立新上下文评审者只读已消毒、已 pin 的输入（base/head diff、契约、policy、record、证据），不执行项目代码、不联网、不写文件；披露「指令级边界、无 OS 强制、同模型族限制」。不上传任何数据到云端。
- Identity：每次评审保存 request/receipt；复用结果前用 `validate-findings.sh` 校验预期 job/base/head/scope/input hash。
- Heuristics：项目惯例见 `docs/ARCHITECTURE.md`、`CONTRIBUTING.md`；豆包口径以 `docs/ARCHITECTURE.md` 豆包一节与运行记录为准（不做估算补全、不虚构成本、不配价）。
- Docs paths：`docs/*.md` 且不在 `src/` 内的文档改动可跳过阶段对抗评审（落地审计照常跑）。
- Budget：每评审门 2 轮；阶段评审逐阶段跑；落地评审必跑；单次运行最多 4 个评审门（3 个阶段 + 落地）。
- Codex：`CODEX_REVIEW_MODEL`/`EFFORT`/`TIMEOUT` 不适用（CLI 缺失）。
- Cloud model reviewer：无（无 key；不批准上传）。

## Run records

本次运行记录：`docs/runs/run.md`（RUN-RECORD-TEMPLATE 结构）。后续新运行另起文件 `docs/runs/run-<slug>.md`。
