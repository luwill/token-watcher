# 修复 token 统计与官方口径的三处偏差

## 2026-10-14 发布显示调整与 PR #14 / #15 修复（1.9.5）

用户明确授权提交、推送 Antigravity 名称显示调整，并与已合并的两个 PR 一起发布新版本；包含本次已验收产物的现有 npm-release 环境审核。仅沿用本对话批准的 `/private/tmp/token-watcher-pr-repair-4g3ayoux/` 合成库与临时文件清理范围。

1. [x] 核对 GitHub/npm 版本与 main，确认 1.9.5 可用，整理限定本次范围的独立候选。
2. [x] 同步版本、lockfile、更新日志与发行说明，验证两版本完整回归、universal 构建与干净安装包。
3. [x] 提交推送本次改动，确认最新提交 CI，创建版本标签并核对云端草稿产物。
4. [x] 通过现有 OIDC 流程发布，核对 GitHub/npm 版本、产物与 provenance，再更新 Homebrew tap。

Windows 同步任务的未提交文件与私人配置不进入发行包；正式数据库和本机采集服务不进入此次发布步骤。

预检：GitHub latest 与 npm latest 均为 1.9.4，main=cd9a666；v1.9.5 标签与 npm 1.9.5 均未占用。独立候选从合并后的 main 建立，仅带入六个已授权的显示/说明文件及版本、发行说明变化。

本地候选：74 个包内文件与源码逐字节一致；菜单栏包含 x86_64/arm64。Node 22.13.1/24.14.0 完整隔离回归分别通过 899/903 项；干净安装版本、Antigravity 名称、请求序号及八个资源/API 端点通过。安装包 SHA-256=aef841698e6964fdbbbb1ad07f5da5aac734e234190504af078601a8e4983467；收据位于批准临时目录的 `release-1.9.5/`。

版本提交 553a4be 已推送 main；[CI 38550917540](https://github.com/luwill/token-watcher/actions/runs/38550917540) 的 10 项任务全部成功。标签与后续草稿/正式发布仅针对该已验收提交。

v1.9.5 标签已推送，[草稿运行 38551340589](https://github.com/luwill/token-watcher/actions/runs/38551340589) 验证成功；云端草稿包与本地候选逐字节相同，GitHub asset digest 和 SHA256SUMS 一致。正式 OIDC 发布已启动。源工作区通过三方合并同步到版本提交，保留并行设备与 Windows 工作树变化。

正式 [发布运行 38551703601](https://github.com/luwill/token-watcher/actions/runs/38551703601) 经本轮授权的 npm-release 审核，四项任务全部成功；npm version/latest=1.9.5，[GitHub v1.9.5 Release](https://github.com/luwill/token-watcher/releases/tag/v1.9.5) 已公开为 latest。registry、本地、草稿和待审正式包逐字节相同，SHA-1/SHA-512 与 asset digest 均匹配。SLSA subject SHA-512、main、release.yml、提交 553a4be 与本运行精确绑定；npm audit signatures 无 invalid/missing。

Homebrew [tap 提交 e669342](https://github.com/luwill/homebrew-tap/commit/e669342b17c0f0e05baad3c7e0f84e709f0d6bfd) 已公开并核对远端文件，地址和 SHA-256 正确，Ruby 语法通过；主仓库公式回填提交 35a3bc7 已推送并同步到本地，903 项完整隔离回归通过。最后的 [主线元数据 CI 38552830564](https://github.com/luwill/token-watcher/actions/runs/38552830564) 十项任务全绿，发布完成。发布收据：批准目录内 `release-1.9.5/release-verification.json`。

## 2026-10-14 修复并合并 PR #14 / #15

用户授权修复两项审查问题，测试通过后合并原 PR。使用独立候选目录，保留当前未提交的显示与 Windows 同步改动。

1. [x] 固定 main 与两个 PR 的原始 SHA，确认贡献分支写权限，准备隔离候选和验证环境。
2. [x] 修复 OpenCode 迭代语句生命周期及会话详情请求竞态，增加可失败的回归用例。
3. [x] 验证 Node 22.13 / 24、内存受限扫描及迟到响应；完整回归通过后提交并更新原 PR。
4. [x] 确认两个 PR 的最新 SHA 与多平台 CI，再依次合并并检查合并后 main。

正式用量库不进入验证。用户确认允许仅在 `/private/tmp/token-watcher-pr-repair-4g3ayoux/` 内创建合成数据库和清理测试临时文件。原始 main=1cacb50，PR #14=a54544b，PR #15=3cb0297；两个贡献分支均允许维护者修改。

已确认旧 #15 在 Node 22.13.1 下同时失败于强制 GC 和 48 MiB 堆扫描；旧 #14 的竞态回归出现 11 项失败。修复后 #15 在 Node 22.13.1/24.14.0 完整隔离回归通过，#14 定向回归及组合候选的完整隔离回归均通过。

PR #15 修复头为 6d4d72f，Node 22.13.1/24.14.0 分别通过 860/864 项；PR #14 组合修复头为 37683e9，两版本分别通过 897/901 项。普通推送原贡献分支，保留全部原提交历史；两个 PR 的新 CI 各 10 项全绿。测试日志保存在批准目录的 `runtime/logs/`，可复用方法记录于 `learnings/2026-10-14-pr-streaming-and-request-lifetime.md`。

已依次合并 #15（c827561）和 #14（cd9a666）；最终 main 与已测试的组合候选树完全相同（83ec9a3813aaefb52216b21b00cd3ce6850ed484），[合并后主线 CI 38547100768](https://github.com/luwill/token-watcher/actions/runs/38547100768) 的 10 项任务全部成功。本地 main 已快进，5 个合并文件与测试候选逐字节一致；既有显示改动保留，Windows 文件与计划的并行更新不回退。未发布或改正式数据库/服务。

## 2026-10-14 发布 Cowork 与 Windows 路径修复（1.9.4）

用户明确授权提交、推送 GitHub 并发布 1.9.4；该授权包含本版本既有 npm-release 环境的发布审核。Windows 内网同步任务的文件和个人配置不进入本次提交/发布。测试沿用已批准的隔离目录、合成库与清理范围。

1. [x] 核对 main、GitHub/npm 当前为 1.9.3，1.9.4 未占用；准备版本、lockfile、更新日志与发布说明。
2. [x] 独立候选快照 863 项完整隔离回归通过，73 个包内文件与候选逐字节一致；universal 为 arm64/x86_64。干净安装版本为 1.9.4，合成 Cowork 两次扫描保持 2 事件/500 tokens，八个资源/API 端点及数据库对账通过。
3. [x] 修复提交 a68bb17 与 v1.9.4 已推送；[CI 38525155965](https://github.com/luwill/token-watcher/actions/runs/38525155965) 的 10 个任务全绿。[草稿运行 38525439731](https://github.com/luwill/token-watcher/actions/runs/38525439731) 验证成功，云端/本地安装包及校验文件逐字节相同。
4. [x] [发布运行 38525940019](https://github.com/luwill/token-watcher/actions/runs/38525940019) 经本轮授权的 npm-release 审核，4 个任务成功；npm version/latest=1.9.4，[GitHub Release](https://github.com/luwill/token-watcher/releases/tag/v1.9.4) 已公开为 latest。registry 与审核产物逐字节相同，SHA-1/SHA-512、GitHub asset digest 和 SLSA provenance（a68bb17/main/release.yml/本运行）均核对通过，npm audit signatures 无 invalid/missing。Homebrew [公式提交 2594247](https://github.com/luwill/homebrew-tap/commit/2594247f7feb841af0067fd75b64173272a5a3fb) 已同步，Ruby 语法通过。

正式用量库与本机全局安装/服务不进入发布步骤；本次不会自行回填或重启。

最终安装包 SHA-256=4ecb4f363a26d80c9db536c8b4f5eea20dd7457ae281a87d28873fb69f98d292；本地候选、草稿、待审正式运行与 registry 包完全一致。73 个包内文件、30 项定向测试、863 项完整隔离回归及干净安装验证完成。

## 2026-10-14 Windows 公司内网自动同步接入

### 用户选择只同步用量元数据

Windows SSH 已修复，实际握手服务端为9.5；用户提供的主机公钥经SHA-256核对并与实际握手一致，已固定专用known_hosts，免密成功，Node=22.13.0。自动审批拒绝完整会话传输后，用户明确选择仅用量元数据；原始日志传输不再属于当前方案。

1. [x] 验证网络/身份/运行时，仅读数量得Claude 43个日志约55MB、Codex 87个约319MB，均无压缩档。
2. [x] 实现Windows本机白名单投影，仅保留用量/时间/模型和哈希标识；用合成日志验证无正文/路径/凭证泄露，保持既有采集器兼容。
3. [x] 部署导出器并只同步导出的元数据；内存核对口径与重复执行，更新5小时任务模板。
4. [x] 取得数据库操作确认后登记元数据roots、重启单一正式服务并启用任务；验证总账与定时任务。

元数据投影、现有已安装采集器口径、追加/重写保护，以及客户端拒绝原始路径/幂等下载的文件内存测试通过。导出器上传后SHA-256已核对，Mac已安装独立元数据程序，生效roots尚未改变。 首次仅元数据同步130个文件、3,960,178 bytes；第二次下载0。现有1.9.2采集器内存核算6,293条、738,714,177 tokens，重复扫描新增0；所有项目均为windows-office。Claude 1,108条/204,422,654 tokens，Codex 5,185条/534,291,523 tokens。用户已明确确认正式库备份/导入、现有服务重启和5小时任务启用。初步内存汇总未包含Store的较完整流式片段补齐，正式导入后按真实Store规则逐字段核对6,293条、739,019,282 tokens（Claude 204,727,759；Codex 534,291,523），所有字段差异为0，已补充多片段补齐专项测试。

执行事故：部署失败后误启动旧同步程序，复制了129个原始日志及暂存/状态文件约374MB，未登记roots或导入数据库；已禁用旧程序，隔离数据并告知用户。用户明确确认后，已精确删除该隔离目录并保存清理回执，Windows原件未动。后续部署和运行分步核验成功状态，禁止失败后继续依赖步骤。

最终接入验收：正式库备份于~/.tokenmeter/backup-windows-metadata-20261014-180215/tokenmeter.db，62,398,464 bytes，SHA256 cae928540189318718230d0f94d331fbd8a40ee9fb14d8c1c659b3475b0643df，quick_check=ok；导入前112,513条/19,610,253,183 tokens，导入后备份既有行缺失0、修改0。生效roots保留VPS并仅追加windows-usage下Claude/Codex目录；重启既有com.tokenmeter.server，未启动第二个写进程。com.tokenmeter.windows-sync已加载，RunAtLoad=true、run interval=18000 seconds、首次退出码0；首次自动触发捕获Windows新会话，当前131个元数据文件、6,309条/740,223,854 tokens（Claude 1,108条/204,727,759；Codex 5,201条/535,496,095）。现有VPS任务仍300秒/退出码0；仪表盘HTTP200、parse_errors=0、quick_check=ok。回执在~/.tokenmeter/remote/windows/integration-receipt.json。

1. [x] 检查物理网卡、路由及 SSH 协议握手，排除 TUN 接管造成的假连通。
2. [x] 准备只同步 Claude Code / Codex 日志的增量 SFTP 脚本和独立 Mac 定时任务配置，保留 VPS 配置。
3. [x] 验证脚本与失败恢复，生成 Windows OpenSSH、公钥授权和限源防火墙配置命令。
4. [x] Windows 完成配置后核对主机指纹、免密及首次同步；用户确认后正式库仅导入元数据并启用5小时任务。

初期未运行数据库测试或正式库扫描；后续隔离目录删除与正式库备份/导入均由用户分别明确确认。其他会话进行中的采集器改动保持原样。

实测：Mac en0=192.168.10.245，目标192.168.20.61默认经utun4/198.18.0.1；默认TCP连接成功但SSH无握手，绑定en0的22/445均超时，尚不能认定Windows可达。用户确认Mac为公司办公网络，Windows使用Terminal（不据此排除WSL）。专用密钥已生成；脚本、带公钥的Windows配置脚本、5小时LaunchAgent模板、pending roots保存在~/.tokenmeter/remote/windows相关路径；未加载任务或写入生效roots，实际脚本仍报LAN SSH超时。9项专项检查（含真实本地SFTP空格/方括号文件名传输）、plist语法与diff空白检查通过；PowerShell尚未实机执行，待用户安装SSH并返回主机身份和目录检查结果后续接入。用户随后将同步周期改为每5小时（StartInterval=18000），模板和说明已更新并通过plist语法验证。

Windows 实机反馈：旧 setup 在首次 Start-Service sshd（第39行）报 CouldNotStartService，后面的公钥配置尚未执行。补充只读启动诊断脚本与 setup 失败诊断；将防火墙备份移出 SSH 系统目录，避免提前创建该目录产生权限继承问题。微软官方有目录权限导致同类启动错误的记录，但当前原因待 Windows 的配置校验、ACL 和事件输出确认；不直接重置 ACL、覆盖主机密钥或重装。5小时同步设置保持，仍未启用任务或导入数据库。

后续截图：SSH 根目录 owner=Administrators、SYSTEM/Administrators=FullControl、Authenticated Users=ReadAndExecute，符合微软所列目录权限；不能据此排除 logs/配置/主机密钥 ACL。sshd -t 与输出退出码的字符串被合在一条命令，没有可见退出码；OpenSSH 日志查询的 SilentlyContinue 也掩盖了日志不存在/无记录等情况。补充 sc.exe qc/query、显式分隔的退出码、日志启用/记录状态，以及 System 的 Service Control Manager 和 Application 1000/1001 记录，优先区分服务程序路径/账号、服务退出码与进程崩溃，尚未确定根因。

最新实机输出：服务路径为系统 inbox OpenSSH、账号 LocalSystem；sshd -t=-1073741511，经32位换算为0xC0000139。微软NTSTATUS定义为STATUS_ENTRYPOINT_NOT_FOUND，确认所需DLL入口不可用；System事件7000/7009记录30秒服务响应超时。优先排查程序依赖；微软官方另有客户端/服务端/libcrypto.dll版本不匹配导致同类1053超时的说明，当前仅为有来源的候选解释，具体DLL/入口与实际版本差异尚未确认。诊断脚本补充系统/文件版本与十六进制状态；不提高服务超时、不替换DLL或删除/重装组件。后续若为FOD错配，按对应Windows累计更新修复，先取得系统build/组件版本再给具体步骤。

组件输出进一步确认：Windows 10 21H2/19044.7725；inbox sshd.exe=7.7.2.3/OpenSSH_7.7p1，ssh.exe=9.5.5.2/OpenSSH_9.5p2，System32/libcrypto.dll=3.8.2.0。服务端/客户端跨代错配已确认，结合0xC0000139，与官方错配故障一致；仍未取得具体缺失函数的加载器记录。优先从Windows Update安装适用的累计更新：2026-10-13 KB5126657支持适用的LTSC/ESU版本，将对应21H2系统升至19044.7807；实际edition/架构未由截图确认，不直接指定MSU包或强装。完成更新并按提示重启后，须重新验证sshd -t=0、服务Running，再重跑已准备setup完成公钥等配置。若公司策略不提供更新或更新后仍未修复，依据具体提示选择下一步；当前不删除组件、不手工替换DLL或调整服务超时。

## 2026-10-14 修复已确认的 Cowork 漏采与 Windows 路径

用户授权实现已确认的问题并补测试。沿用已批准的 `/private/tmp/token-watcher-antigravity-fix-wbmnvnuv/` 合成库及测试删除范围；本轮不运行正式库回填或重启服务。

1. [x] 限定已验证的 agent/local_ditto/.claude/projects 与 audit，剪枝输出/插件目录；官方 Claude 按消息 ID 去重，仅迁移已观察旧键。CLI/配置共用宿主平台的扩展路径归一。
2. [x] Cowork roots 接入 claude-code v3；标准 transcript 优先、audit 回退，来源优先级持久化，旧键合并与游标同事务。ccmr 保持旧键/流式规则，result.modelUsage 不叠加。
3. [x] 新增 30 项定向回归：平台路径/宿主 CLI-config 集成、约束发现、正反扫描、镜像与缺 requestId、重开优先级、晚到字段、旧键迁移、缺源/删除及失败回滚。原故障注入改为拦截实际 Claude 写入方法，回滚断言保持。
4. [x] macOS Node 24.14.0 下 863 项完整隔离回归全通过；真实历史日志仅进内存，独立逐字段核对，正反顺序及重复重放均为 113 唯一消息/117 唯一调用。语法/diff/打包检查通过，新模块和报告入包，私人副本/收据排除；README、调查/部署说明与工程笔记已更新。Windows 使用 win32 模拟和跨平台夹具，未称为反馈者实机验收。未发布或改正式服务/数据库。

验收收据：批准的临时目录下 `cowork-fix/focused-test.log`、`full-test-final.log`、`historical-verification.json` 与 `pack-verification.json`。未新增依赖；发布版本仍为 1.9.3（本轮补丁尚未发行）。

## 2026-10-14 调查 Claude Desktop 用量覆盖

补充反馈：用户确认 Chat、Code、Cowork 都受影响，平台 Windows。随后说明版本不明、暂无法询问；此前 `1.8.2` 的软件归属未确认，仅作为 token-watcher 发布版本对照，不当成反馈者已确认安装版本。Claude Desktop 版本和 Code 执行位置均未知，不等待补询。用户已允许只读检查 Claude IndexedDB/Local Storage 并在此前批准的临时目录建立隔离副本。

1. [x] 核对实际 npm 1.8.2 发布包与当前版本；Claude 采集器相同，1.8.2 未含 extra-roots。Windows 候选路径与只读 PowerShell 检查方法已写入报告；暂无法取得反馈者实机结果，该个案原因保留为未验证。
2. [x] 两处获准存储复制前后及解码后 SHA-256 一致；离线解码 79 个 Local Storage 项、5 条 IndexedDB 数据记录，未发现常见精确 token 字段。跳过凭证名称，不读取 Cookies/外部 blob，不改原库。
3. [x] 1.8.2 对同一历史 Cowork 样本复现相同漏扫/格式问题；Desktop Code 日志路径引用均为目录缺失线索。额外复现当前 extra-roots 拒绝合法 Windows 盘符与 UNC 路径，发生在配置写入前；该缺陷仍未修改。
4. [x] 更新调查说明、Windows 只读排查片段和忽略的工程笔记；git diff --check、旧版内存 probe、脱敏字段检查及打包清单通过。报告纳入后续包清单，私人收据/副本不入包；仅升级 1.9.3 不能覆盖三种模式。本轮无采集器修改、提交推送或正式库回填。

此前已完成的第一轮证据：

1. [x] 检查现有 Claude 采集源、配额路径与 GitHub 用户反馈；区分 Chat、Code 和 Cowork。
2. [x] 核对官方文档、历史 local-agent JSONL 与配额缓存字段。当前正式 Claude.app/ASAR 未找到，未进行已安装最新版的静态分析；证据限定于 2026-03-25、CLI 2.1.78 的历史 Cowork 样本。
3. [x] 现有采集器直接读日志至内存 sink，不打开数据库：标准 transcript 可解析，audit 因缺少 timestamp 被跳过；两者均未归属已配置扫描 root。对齐消息 ID 发现输出字段差异及额外 modelUsage，证明不能直接叠加。
4. [x] 保存 docs/CLAUDE-DESKTOP-AUDIT-2026-10-14.md，区分本地/云端 Code、历史 Cowork 和 Chat 的覆盖与未知范围，并给出修复及验收方案。

调查阶段不修改真实用量库、不使用账号凭证调用未验证接口，也不向反馈用户发表评论。

只读内存验证收据保留于本地临时目录的 claude-desktop-audit/probe-report.json；公开调查说明不包含私人会话正文、账号/会话 ID 或实际用量合计。Windows 客户端路径与格式仍需实机样本，不能把本机旧日志原因直接认定为该用户唯一原因。

## 2026-10-14 发布 1.9.3 并首次验证 npm Trusted Publisher

用户明确授权发布 1.9.3 并完成 npm Trusted Publisher 首次验证。本次授权适用于已验收的安装包及相应 GitHub 发布环境审核；后续版本仍须另行确认。

1. [x] 核对 main、registry、发布环境与 npm/GitHub 官方文档；准备 1.9.3 版本、lockfile、更新日志和发布说明。
2. [x] 829 项完整隔离回归通过；69 个包内文件与源码逐字节匹配，universal 为 arm64 + x86_64；干净安装版本和八个资源/API 端点通过。
3. [x] 版本提交 370e6b6 与 v1.9.3 已推送，[main CI 38509273605](https://github.com/luwill/token-watcher/actions/runs/38509273605) 的 10 个任务全绿；本地/云端/草稿/正式发布包逐字节一致。[发布运行 38509791735](https://github.com/luwill/token-watcher/actions/runs/38509791735) 经本次用户授权的 npm-release 审核，全部任务成功。
4. [x] npm version/latest=1.9.3，[GitHub Release](https://github.com/luwill/token-watcher/releases/tag/v1.9.3) 已公开为 latest；registry 包与候选字节、SHA-1/SHA-512 一致。npm audit signatures 无 invalid/missing，provenance 绑定 370e6b6、release.yml 和上述运行；npm 页面 Publisher 状态为 Valid。Homebrew [3fc696f](https://github.com/luwill/homebrew-tap/commit/3fc696f4f5b6a58fcef2f56a679402cc7cf26225) 已同步版本和 SHA-256，Ruby 语法通过。

测试沿用此前授权的临时目录与合成数据库/清理范围。正式用量库、本机服务不进入本次发布操作。

最终发布包 SHA-256=8423ec28fc9ce04af1ca489da7dacb228149b22443bf15f3cd68cfd94b562ee5；本地候选、草稿附件、publish artifact 与公开 registry 包完全相同。首次 Trusted Publisher 验证完成，后续发版仍需要维护者明确授权。

## 2026-10-14 每日维护 Loop 与 CI/CD

1. [x] 阅读 Anthropic Loops、Codex 定时任务和 GitHub/npm 官方文档；盘点 PR/Issue 与现有 CI。
2. [x] 实现增量队列扫描、维护协议和有明确停止条件的每日定时循环；真实队列重复扫描 changed=0，Codex 每日任务已启用。
3. [x] 补齐受 CI 校验的构建/发布工作流；默认仅演练，正式发布需明确选择；YAML/Bash/嵌入 Node 语法通过，补充草稿复用与附件核对后完整隔离回归 829 项通过。
4. [x] 完成真实队列、云端重复扫描、定时任务与发布演练验收。补充草稿核对后 [CI 38508200184](https://github.com/luwill/token-watcher/actions/runs/38508200184) 的 10 个任务全绿；[verify 38508226478](https://github.com/luwill/token-watcher/actions/runs/38508226478) 产物与已发行 1.9.2 校验值一致，npm/GitHub 正式发布步骤均跳过。

默认日程为每天 09:00（Asia/Taipei）；自动扫描、有限修复与草稿 PR，合并和正式发版由维护者确认。npm 发布采用 OIDC，不复制本机令牌到仓库；每次仍经人工审核。真实日志/数据库与本机服务不进入日常维护测试。

GitHub `npm-release` 环境已设置：仅 `main` 分支、审查人 `luwill`，允许本人发起并审核。用户批准并完成身份验证后保存 npm Trusted Publisher；随后按用户指令真实发布 1.9.3，状态已变为 Valid。首次验证期限不再是待办；后续发版仍须另行授权。验证记录与运行链接见 docs/MAINTENANCE-LOOP.md。

## 2026-10-14 发布 Antigravity 与模型价格修复（1.9.2）

用户已授权将本轮修复一起提交、推送 GitHub 并发布新版本。

1. [x] 核对远端 main、GitHub/npm 版本和发布流程，确定补丁版本 1.9.2；整理公开修复与恢复说明。
2. [x] 完成版本回归、macOS universal 构建、打包与干净安装验证；820 项回归、67 个包内文件与源码逐字节匹配、干净安装的 CLI/实数采集/Flash 与 Argon 计价及 8 个资源端点通过。
3. [x] 提交推送本轮修复，确认多平台 CI；提交 9f2bc23、v1.9.2 标签已推送，GitHub Release 草稿与发布包已准备。
4. [x] 发布并核对 GitHub、npm registry、安装包校验值和 Homebrew 更新结果。

npm 预检曾返回 E401；用户完成 CLI 登录与本次发布身份验证后恢复发布。测试沿用本轮已授权的隔离目录和清理范围。本机数据库备份、逐键对账及个人用量证据保留本地，不进入公开发行包。

发布候选：token-watcher-1.9.2.tgz，SHA-256=76ba2ed8528e5020082e75ff96e2e15215c8d9fa8175ec393c24dcff65579679；菜单栏 universal 为 x86_64 + arm64。package-lock 与 package.json 统一为 1.9.2，公开恢复与价格说明包含在包内。

GitHub 验收：[CI 38499911237](https://github.com/luwill/token-watcher/actions/runs/38499911237) 的 10 个任务全部成功（macOS/Linux/Windows、Node 22.13/24，另含安装与 import 冒烟）。安装包的 GitHub SHA-256 与本地候选一致。

发布完成：GitHub [v1.9.2 Release](https://github.com/luwill/token-watcher/releases/tag/v1.9.2) 已公开并标为 latest，标签对应代码提交 9f2bc23；包含安装包与 SHA256SUMS。npm 已确认 version=1.9.2、latest=1.9.2，公开下载包与本地候选逐字节相同，SHA-1=921ed1f03f13be8c65deca7598cea9cc3e58ec63，SHA-512 与发布候选一致。Homebrew tap 已同步 1.9.2 地址与 SHA-256，[tap 提交 10e1d50](https://github.com/luwill/homebrew-tap/commit/10e1d50589a4f07e2d8baf1602903361232796c7)；公式 Ruby 语法通过。升级命令：npm install -g token-watcher@1.9.2。

## 2026-10-14 已完成的 Antigravity 与模型定价修复

- [x] 按逐轮真实 usage 记录非缓存输入、缓存读和含思维输出；旧日志改用完整上下文估算，标明质量。
- [x] 修复晚到 usage/metadata、重复/full 日志、ACTIVE/DONE 及仅更新已有记录时的面板通知；采集版本升至 v3。
- [x] 按用户授权完成正式库一致备份与 Antigravity 历史回填；独立逐键、逐字段核对和重复扫描幂等通过，其他来源不受回填影响。
- [x] 补齐 Argon 与 11 个原缺价名称的官方价/来源别名（含 2 个免费名称），保留未知路由名称的缺价提示。
- [x] 修复缓存写价、优惠截止和 Cursor MAX/Grok Fast 模式；费用卡、按天图与 ROI 共用同一解析链路。
- [x] 完整隔离回归 820 项通过；只读实库费用试算、在线 API 与实际 ECharts 悬浮明细一致，Antigravity 健康正常。

公开说明：docs/ANTIGRAVITY-AUDIT-2026-10-14.md、docs/ANTIGRAVITY-RECOVERY-2026-10-14.md、docs/MODEL-PRICING-AUDIT-2026-10-14.md。

## 2026-10-10 合并 PR #2 并发布 1.8.4

用户明确授权合并 PR #2、提交推送补充修复并发布新版本；沿用本轮已确认的隔离合成数据库测试与临时文件清理范围。

1. [x] 核对远端 main、PR 提交、GitHub/npm 版本和发布账号状态；目标为补丁版本 1.8.4。
2. [x] 完成 PR CI 并合并；提交日期窗口等补充修复，保留本地 Cursor 修复和贡献者提交历史。
3. [x] 完成版本回归、universal 菜单栏构建、打包与干净安装验证，推送代码并检查 CI。
4. [x] 创建 v1.8.4 标签和 GitHub Release，上传安装包及校验文件；恢复 npm 认证、发布并核对 registry。

预检：npm latest 为 1.8.3，GitHub 最近 Release 为 v1.8.0；npm whoami 返回 E401，须在产物就绪后重新认证。PR #2 的首次贡献者 CI 已获准运行。

发布预验收：PR #2 三平台/Node 22.13 与 24 的 10 个 CI 任务全部通过，已通过保留提交历史的 merge 合并为 `f722222ff26cf5b93aed0b0aa545d2c139e1716c`。1.8.4 本地完整回归 644 项通过；prepack 构建 arm64 + x86_64，61 个包内文件逐字节匹配工作区，干净安装后的 CLI 版本及 8 个资源/API 端点通过。安装包与 SHA256SUMS 位于 `/private/tmp/token-watcher-pr2-KyI6bp/release/`。

发布完成（2026-10-10）：补充修复提交 `6bd611f`，与 PR 历史整合后为 `dd0c6d2294888686ebce66e91610cb151927d1f3`，已推送 main；v1.8.4 标签指向该发布提交。最终代码 CI [38034740378](https://github.com/luwill/token-watcher/actions/runs/38034740378) 的 10 个任务全部成功。用户完成 npm 登录与发布双重验证后，registry 已确认 `version=1.8.4`、`latest=1.8.4`，SHA-1/SHA-512 与本地安装包一致。公开 [GitHub Release](https://github.com/luwill/token-watcher/releases/tag/v1.8.4) 含安装包和 SHA256SUMS；安装包 SHA-256 为 `176024561414c83a2ab08dc816c425b2bcb42b3c8b0ea249ab4db1b892dc9689`。本次不重启正式服务、不改真实数据库或云端历史。

## 2026-10-10 Codex 压缩日志与统计窗口反馈

1. [x] 核对 PR #2（`5e6f9f96fa5653a64f2a1bf77b837b6c4b74c87d`）、截图与本地/云端统计路径。
2. [x] 接入 PR 的压缩日志发现、解压、快照重扫和跨格式去重，保留本地已有 Cursor 修复。
3. [x] 统一本地近 N 天为含今天的本地自然日；排行榜客户端对齐服务端 UTC 自然日；增加压缩历史进入 7/30 天窗口的回归。
4. [x] 运行隔离合成数据测试、语法检查与 diff 检查，补充恢复步骤和云端边界说明。

截图中的私人数据数字属于用户提供的对账结果，本轮用可复现合成数据验证机制，不把这些数字当作本机实测。云端现有防伪造策略拒收过去日期，客户端修复不能自动回填过去的云榜数据。
用户已确认本轮隔离测试及临时文件清理：仅在 `/private/tmp/token-watcher-pr2-KyI6bp/` 下创建测试家目录、读写合成 SQLite 库并清理测试生成的临时文件；真实用量库及云端 D1 不在测试范围内。

验收（macOS，Node 24.14.0）：18 项定向检查、644 项完整回归均通过，0 失败。另有 52 个 JS/MJS 文件语法、三种文件后缀及 Windows 工具调用去重键、zstd CLI/Node 单帧与多帧安全检查、Asia/Taipei/UTC/纽约春秋夏令时边界、`git diff --check` 通过。`npm pack --dry-run --ignore-scripts` 确认 61 个打包文件中包含新模块及恢复说明。没有新增依赖，未变更发布版本。

完整回归使用独立 HOME/XDG/临时目录；CLI 子进程离线，父进程仅放行回环 HTTP，拦截真实外网 fetch，允许套件中的模拟网络用例运行。此前两次运行分别被沙箱禁止监听本机端口、测试运行器的全局离线开关干扰模拟请求；调整运行器后全量通过，业务代码未为此放宽网络规则。
日志：`/private/tmp/token-watcher-pr2-KyI6bp/focused.log`、`/private/tmp/token-watcher-pr2-KyI6bp/full.log`。恢复说明：`docs/CODEX-COMPRESSED-HISTORY.md`。本地验证阶段结束时尚未发行；后续合并与发布结果见上方 1.8.4 发布记录。

---

起因：2026-09-16 用户发现面板显示 DeepSeek V4.1 Flash 今日 ¥8.34，
而 DeepSeek 平台显示当日总消费 ¥58.24 / 2,585 请求 / 1.626 亿 tokens。
定位后确认定价表无误（USD 表 ×6.67 = 官方峰时价），问题全在数据进库之前。

对账（诊断时点）：

| | 请求 | tokens | 峰时价成本 |
|---|---|---|---|
| ccmr 现状 | 1,000 | 84.4M | ¥8.34 |
| ccmr 修正后 | 1,000 | 85.5M | ~¥17.10 |
| dsh（完全缺失） | 548 | 59.6M | ~¥8.20 |
| 小计 | 1,548 | 145.1M | ~¥25.3 |
| 平台实测 | 2,585 | 162.6M | ¥58.24 |
| 残差（沉浸式翻译 / ragflow / arteryflow） | ~1,037 | ~17.5M | ~¥33 |

残差摊薄约 ¥1.9/M ≈ 未命中单价 ¥2/M，符合"翻译类调用零缓存命中"的特征，账能对上。

## 阶段 1：ccmr 输出 token 丢失 94.5%

Claude Code transcript 把一次 API 响应按 content block 拆成多行（`apiBlockIndex` 0..n），
共享 `message.id`，input/cached 每行重复，**`output_tokens` 只有终结块是真值，前面全是 0**。
`dedup_key = ${tool}:${msg.id}:${requestId ?? ''}`，而网关不写 `requestId`
（今日 3416 行全 undefined；官方 Claude Code 936 行全有），四个 block 塌成同一个 key，
`INSERT OR IGNORE` 留下第一条 = output 0。

- [x] 测试：ccmr 夹具加一条无 requestId 的多 block 响应，断言取到终结块的 output
      （RED 实录：`ccmr 终结块输出 500 而非 0 [{"o":200},{"o":0}]`）
- [x] 实现：改在 store 层——"输出更大的后来者补齐该行"
- [x] 决策：放弃"跳过 `stop_reason == null`"。它会新增一条静默丢弃路径，
      某个源不写该字段就整源归零，正是本次要修的事故类型；现有两个夹具
      恰好都没写这个字段，说明该字段确实容易被省略
- [x] ccmr 升 version 3 触发全量重扫，补正存量行（claude-code 已验证无恙，不动）

## 阶段 2：dsh 自 2026-08-14 起完全停采

dsh 升级会话格式，采集器只认旧结构，打开文件后一条也匹配不上，返回 0 且不报错。

| | 采集器认的 | v3 实际 |
|---|---|---|
| 文件名 | `session.jsonl.zstd` | `session.v3.jsonl.zstd` |
| 记录类型 | `assistant/chunk` + `chunk.type=='usage'` | `assistant/message` |
| usage 路径 | `data.chunk.usage` | `data.usage` |
| 字段名 | `inputTokens` 等 | 不变 |

- [x] 测试：v3 + 旧格式各一份夹具（zstd CLI 压缩，缺失时守卫跳过）
      （RED 实录：`dsh 1800 → {"t":320,"n":1}`，v3 文件颗粒无收，
      旧格式两条断言通过，证明向后兼容当时是好的）
- [x] 实现：解析 `assistant/message` + `data.usage`，补 `cacheWriteTokens`，
      模型优先 `data.message.source.model`，回落 `request/header`
- [x] dedup_key 隔离：v3 的键加文件名（`dsh:${fileId}:${file}:${seq}`），
      旧结构的键保持原样，避免历史事件重扫时被当成新行再插一遍。
      这点因阶段 1 的补登逻辑变得更要紧：撞键不再只是被丢弃，而会覆写旧行
- [x] dsh 升 version 2 触发全量重扫，补回 8-14 以来的用量

## 阶段 3：峰谷价未实现

`pricing.js` 只有注释写着"峰时价（谷时减半）"，没有任何代码，谷时用量被高估一倍。
方向与前两个 bug 相反，此前被掩盖。

- [x] 查证官方定义（api-docs.deepseek.com/quick_start/pricing，2026-09-16 核对）：
      **峰时 = UTC 周一至周五 01:00-04:00 与 06:00-10:00**，其余一切时段为谷时，减半。
      与"北京时间半夜打折"的想当然完全不同，幸好没凭记忆写：按 UTC、跳过整个周末、
      两段峰时之间 04:00-06:00 还有个空档，三处都容易错，各钉了一条用例
- [x] 同页确认种子表就是峰时价（flash $0.006/$0.3/$1.2，pro $0.044/$1.32/$3.96），无需改价
- [x] 实现：`PEAK_SQL` 片段，让分组与计价共用同一份判定；三处聚合（费用卡、
      按天堆叠图、余额对账）统一带上
- [x] `off_peak` 缺失时回落种子表——老用户的 pricing.json 没这个字段，
      若"缺失即不打折"，峰谷价对他们是个静默空操作（变异测试已验证此用例能变红）

## 约束

- 改采集器须升 `version` → 触发全量重扫、重写正式库（已获用户确认）
- 每个 commit 独立通过全部测试

## 阶段 4（重扫后才暴露）：守护进程解不开 zstd

面板健康自检报 `dsh=error / zstd not installed`，但 zstd 确实装着。原因是常驻服务由
launchd 拉起，其 PATH 是系统默认、不含 `/opt/homebrew/bin`，而 zstd 只装在那里。
于是守护进程从来解不开任何 dsh 快照，只有人在交互 shell 里手跑 `scan` 才正常——
这是个独立的既有 bug，不修的话阶段 2 在面板上等于白修。

- [x] 测试：清空 PATH 精确复现 launchd 环境（RED：`zstd not installed` + 0 事件）
- [x] 实现：优先用 Node 内置 zstd（≥23.8），旧版 Node 回落 CLI 并显式试常见绝对路径
- [x] 变异自检：只禁内置分支时测试仍绿（绝对路径兜住了，两条机制冗余是预期的）；
      两条同时禁掉才变红，说明断言盯的是对外契约而非某一条实现路径

## 收尾

- [x] 三个 commit 各自独立通过全部测试（detached worktree 逐个验证）
- [x] 正式库全量重扫（ccmr v3 / dsh v2 触发），补正存量数据。重扫前已备份至
      `~/.tokenmeter/backup-before-rescan-*`（确认无误后可删）
- [x] 对账验收：
      - ccmr 今日输出 64,828 → **1,169,337**，合计 **85,488,178**，与独立解析原始
        transcript 的预测值完全一致
      - dsh 逐 dedup_key 对账：原始 791 = 库内 791，漏采 0 / 多记 0 / 数值不符 0
      - dsh 全库 165 条 → 1,268 条（+1.7 亿 tokens）

## 2026-09-22 产品与代码评审（不修改实现）

1. [x] 梳理功能、架构、既有评审与当前工作区改动。
2. [x] 使用隔离测试与最小复现验证数据正确性、健康状态和运行边界。
3. [x] 输出按优先级排序的产品与代码评审，说明验证范围和限制（docs/REVIEW-2026-09-22.md）。

本次隔离数据库测试已获用户确认；不操作真实用量库，保留已有 web/app.js 修改。

## 2026-09-22 堆叠柱状图接缝修复

1. [x] 核对截图像素与现有堆叠布局，确认接缝为抗锯齿混色。
2. [x] 两张堆叠图改为 SVG + crispEdges，柱段统一直角，保持数据、配色与交互。
3. [x] 合成数据浏览器验证：760/1100/1600px 宽度、100%/125% CSS 缩放、悬浮提示、图例切换、日期钻取通过；最终版本 407 条回归检查全部通过，git diff --check 通过。

像素验收：样例柱中心扫描，消耗图颜色数 8 → 5、费用图 12 → 5（5 个真实系列，无混色接缝）。截图在 /private/tmp/token-{stack,cost}-{before,after}.png；浏览器使用静态服务与模拟 API，未访问真实用量库。

## 2026-09-22 项目成本与会话归因

1. [x] 数据基础：完整项目路径、历史回填与 Codex 跨路径去重。
2. [x] 项目 API：共用计价链路、覆盖率、趋势、会话与异常标记。
3. [x] 前端：项目榜、详情和逐请求钻取，接入全局时间范围。
4. [x] 验证：全量回归与 9 个新增行为测试通过；桌面/390px 窄屏、搜索、排序、502 条分页、XSS 转义、500 错误恢复、快速范围切换通过。
5. [x] 文档与交付：README 中英文与架构说明已更新；功能代码完成，用户确认后正式库已备份迁移、回填并启用。

沿用本任务已有的隔离数据库测试授权；正式库迁移与重扫在实现验证完成后单独确认。

正式启用验收（2026-09-22）：
- 用户明确允许正式备份、迁移、删除确认重复副本与重启。
- 迁移前/后 96,709 条、15,710,631,740 tokens 完全一致；确认重复副本为 0。
- 回填扫描 2,462 个文件，新增 3 条（进行中的日志）；131 个项目、91,398 / 96,712 条事件有完整路径，无解析错误，quick_check=ok。
- 备份：~/.tokenmeter/tokenmeter.db.before-projects-1790058578097.db。
- 按原有独立进程方式重启 8787（未新增 LaunchAgent），日志仍为 /private/tmp/tokenwatcher-dev.log。
- 正式 /api/projects?days=7 返回 200，抽样 41ms；51 个具名项目及 1 个未归属组；浏览器项目 → 16 条会话 → 500 条请求首屏钻取成功，无面板渲染错误。
- 隔离全量回归 415 条检查通过，另含 9 个项目分析行为测试；真实数据验证不替代上游源账单对账。

## 2026-09-22 撤回项目分析功能

- [x] 将完整功能实现和 diff 存档，移除项目分析界面/API/采集扩展与文档。
- [x] 保留此前柱状图接缝修复及用户原有前端改动。
- [x] 不恢复旧数据库，不丢弃新用量；仅保留已迁移 Codex 键的写入兼容。已有 project_path 列暂留但不使用。
- [x] 回归测试、重启正式服务并确认旧界面恢复。

回退验收：隔离回归全部通过，包含已迁移 Codex 事件/工具调用重扫去重测试；git diff --check 通过。正式 8787 已重启，项目面板不存在、项目 API 返回 404、summary 返回 200，两张按天图仍使用 SVG，无面板渲染错误。数据库 quick_check=ok，重启前 96,734 条，重扫后 96,739 条，未出现大量重复入账；旧备份未覆盖当前数据。

存档：/private/tmp/token-project-feature-20260922-143643

## 2026-09-24 社区排行榜评审与云端部署

1. [x] 审查客户端、Worker、数据库结构、前端与隐私边界，记录可复现问题。
2. [x] 修复上线阻塞项，补充 Worker 行为验证；保留现有工作区改动。最终隔离回归 494 项通过。
3. [x] 核实 Cloudflare 账号、免费部署配置，完成隔离测试与构建。
4. [x] 创建专用云端数据库并部署，验证端点，记录 URL、版本及限制。

本次不读取或上传真实用量库。用户已明确确认专用 D1 创建/初始化、合成数据测试与清理、30 天 GC、隔离测试及其临时文件清理、已有账号登录及 Cloudflare 条款。

当前进展：Wrangler 4.138.0 dry-run 构建成功，本地 workerd + D1 的健康/上报/日周榜/429/413/cron 验证通过。
用户已指定 ygnjd2016@gmail.com 并登录成功；确认该账号 Workers 尚无项目，子域为 ygnjd2016.workers.dev，Workers Free（$0）为当前计划。
用户明确授权 Wrangler 后，已用最小权限 OAuth 完成部署。
线上地址：https://token-watcher-leaderboard.ygnjd2016.workers.dev
Worker 版本：ea1d541e-9172-4f2c-a1cf-7dabb616b1bd；D1 为专用 token-watcher-leaderboard（WNAM）；cron 为每天 03:17 UTC。
线上合成数据验收脚本 cloud/smoke.mjs 的 8 项检查通过；测试行已按随机 UUID 精确删除，真实客户端函数验证榜单为空且个人记录不存在。
src/leaderboard.js 默认 URL 已更新。未发布 npm 包、未重启本地服务、未开启真实用量上传。
部署记录和源码 SHA-256：cloud/deployment.json。Chrome 打开公开接口遇到 net::ERR_BLOCKED_BY_CLIENT；直接 HTTPS 及项目客户端请求均成功。
评审：docs/REVIEW-LEADERBOARD-2026-09-24.md。完整回归日志：/private/tmp/token-leaderboard-review-tests.log。

## 2026-09-24 社区排行榜顶部切换

1. [x] 核对页面结构，切换范围限定为 Token 活动图以上；保留现有视觉样式。
2. [x] 顶部新增社区排行榜入口，与时间范围互斥切换上方概览；活动图以下保持显示。
3. [x] 用合成数据验证切换、时间筛选、主题/导出互不干扰和窄屏布局，完成现有检查。

仅改本地前端，无数据库和云端服务变更。
验收：Chrome 桌面/390px 窄屏、50 人榜单/空榜/服务失败、30/90 天切回、日/周榜、浅深主题和 CSV 原日期范围通过；浏览器无控制台错误。隔离临时 HOME 的完整回归 497 项通过，日志 /private/tmp/token-leaderboard-tabs-tests.log。

## 2026-09-24 社区近 30 日榜

1. [x] 核对口径：滚动 30 天总 Token；主力模型按后续要求改为跟随所选周期。
2. [x] 扩展客户端、Worker、数据库迁移及前端，兼容旧客户端缺失月统计。
3. [x] 隔离回归、浏览器验证；用户明确确认后完成迁移部署和实际榜单验证。

30 日榜本地验收：完整回归 512 项通过（/private/tmp/token-leaderboard-month-tests.log）；随后补充旧服务周期不匹配提示，Worker/UI 定向 34 项通过。Wrangler dry-run 成功；Chrome 桌面和 390px 窄屏通过、无控制台错误。云端迁移及更新上报等待本轮明确确认，尚未部署。

## 2026-09-24 主力模型跟随榜单周期

1. [x] 确认今日使用 UTC 日，与日榜一致；7/30 日为滚动窗口，各取 Token 总量第一名。
2. [x] 客户端按周期聚合，Worker 返回所选周期模型；旧记录缺失时明确提示，不跨期代用。
3. [x] 合成数据验证不同周期有不同主力、边界和旧记录兼容；已授权完成云端迁移与更新上报。

最终上线：用户确认近 30 日榜及周期模型两字段迁移、部署和真实聚合上报。D1 两份增量迁移成功，原参与者保留；Worker 版本 505ae204-2403-44b7-a619-f286acd8db1e。完整回归 525 项、线上合成烟测 9 项通过，测试行精确清理后仍为 1 位真实参与者。本地 launchd 服务已重启，新格式上报成功。实际三个周期 models_period 正确，Chrome 日榜显示 claude-opus-5.5，30 日榜及周期切换正常。日志 /private/tmp/token-leaderboard-model-period-tests.log；线上回执 /private/tmp/token-model-period-live-smoke.json、/private/tmp/token-model-period-live-verification.json。

## 2026-09-24 提交与发布就绪评审

1. [x] 清点待提交改动、发布配置和已有验收证据。
2. [x] 核验升级兼容、CLI/统计边界及 npm 打包/依赖风险，复现必要问题。
3. [x] 输出提交/发布结论，区分阻断项与后续优化；不执行提交或发布。

发布评审结论：暂不建议发布；4 项 P1 已复现（保留字昵称误执行、旧 Codex 键升级重复、days=0 漏历史、stream 回调异常逃逸），另列必要 P2 与版本/依赖收尾。详见 docs/RELEASE-READINESS-2026-09-24.md。本轮仅新增报告/计划，不修改业务代码、真实数据库、云端服务，不提交/发布。

## 2026-09-24 修复四项发布阻断

1. [x] 核对四项复现与调用路径，限定为本地代码及已获授权的临时合成数据库测试。
2. [x] 修复命令位置解析、Codex 旧键事务迁移、全历史参数与流异常传播。
3. [x] 补回归：保留字昵称、旧/新/混存数据库与回滚、HTTP 全历史、扫描失败恢复。
4. [x] 运行隔离完整回归，更新发布评审；不操作真实数据库、不重启线上服务、不提交发布。

验收：完整回归 550 项检查通过（不计最终汇总行），含新增 24 项阻断回归及新增模块语法/import 检查；git diff --check 通过。Codex 迁移原始行在同库归档、冲突取完整快照，临时库验证回滚/重试成功。日志 /private/tmp/token-release-blockers-tests.log。四项 P1 已关闭，P2 和发布收尾保持待办。

## 2026-09-24 发布 1.8.0

用户已明确授权 Git 提交、推送和发布。

1. [x] 核对远端 main、已有版本和登录状态，准备 1.8.0 元数据与发布说明。
2. [x] 完成隔离回归、macOS universal 构建、真实打包和干净安装验收。
3. [x] 提交并推送 main，三平台 CI 的 10 个任务全部通过。
4. [ ] GitHub Release 已公开并核对产物；npm 1.8.0 等待账号持有人完成发布双重验证，完成后核对 registry。

P2 已知限制随发布说明披露，不在本轮扩展重构；不重启用户本机服务，不再执行云端迁移。

发布预验收：1.8.0 完整回归 550 项通过；prepack 构建 x86_64 + arm64，真实包 54 个文件与当前源码逐文件一致，无凭证/数据库/账号配置。临时 consumer 安装成功，CLI 版本及 8 个资源/API 端点通过。产物和日志：/private/tmp/token-watcher-release-1.8.0/。

发布进度（2026-09-25）：提交 1aa534c 已推送 origin/main，v1.8.0 标签指向该提交。CI：https://github.com/luwill/token-watcher/actions/runs/36024063487 。GitHub Release：https://github.com/luwill/token-watcher/releases/tag/v1.8.0 ，包含 npm 格式安装包及 SHA256SUMS；已注明 npm 尚未发布。npm 登录已恢复到 louwill，发布命令等待官方双重验证，浏览器工具不允许操作该安全验证页面，由用户自行完成。未修改真实用量库或重启本机服务。

## 2026-10-14 设备筛选、Windows 同步与视频工具

- [x] 完成设备归属、统一 API/CSV 筛选和前端切换，保留全设备总量与共享账户信息。
- [x] Windows 只导出白名单用量元数据；传输前后校验路径、哈希与字段，完整会话镜像需显式选择。
- [x] 完成合成与本机验收；本机具体网络地址、数据库统计、备份位置和视频数据回执保留在本地，不作为通用产品保证。
- [x] 保留可复用的日度用量导出与视频渲染脚本，生成的数据和视频不进入 Git 或 npm 包。

## 2026-10-21 整合本地改动并发布 1.9.6

用户已明确授权整合、完整回归、提交推送和发布 1.9.6。测试仅使用已批准临时目录中的合成数据；正式数据库、同步任务和服务不在本次操作范围内。

1. [x] 备份全部 28 个本地改动文件与二进制补丁，核对最新 main，建立独立候选。
2. [x] 逐项解决三方冲突，整合设备筛选、Windows 元数据同步与视频脚本，复核公开文档及打包范围。
3. [x] Node 22/24 完整回归、专项测试、语法/格式检查、universal 打包和干净安装验证。
4. [x] 提交推送并核对完整 CI，固定 1.9.6 标签、草稿及产物校验值。
5. [x] OIDC 发布并核对 npm/GitHub、来源证明、签名和 Homebrew；同步本地 checkout。

1.9.6 本地验收：Node 22.13.1 / 24.14.0 分别通过 979 / 983 项主回归检查及 Windows 专项；85 个包文件与候选逐字节一致，菜单栏含 arm64/x86_64，干净 consumer 安装的 14 项检查与五种设备范围通过。设备缓存按连接和设备隔离，健康检查与汇总共用时间边界。测试仅使用隔离合成数据。

发布完成：版本提交 1dee585，v1.9.6 标签固定该提交；[主线 CI 39527201337](https://github.com/luwill/token-watcher/actions/runs/39527201337) 的 10 项任务成功。[草稿运行 39527482797](https://github.com/luwill/token-watcher/actions/runs/39527482797) 与[正式 OIDC 发布 39527686709](https://github.com/luwill/token-watcher/actions/runs/39527686709) 通过；npm version/latest=1.9.6，[GitHub Release](https://github.com/luwill/token-watcher/releases/tag/v1.9.6) 已公开。

本地、草稿、正式工作流与 registry 包逐字节一致，SHA-256=a68a594b876e94ece29d4fe38ce2a6fade512840f86a3a8d174d251be4b2f7d1；85 个包文件与版本候选一致。SLSA SHA-512、main、release.yml、版本提交及正式运行绑定已核对，npm audit signatures 的 invalid/missing 均为空。Homebrew tap 公式提交 85a4366 已推送；本地工作树原 28 个文件经备份哈希校验后整合并提交，同步到发布版本时干净。收据保存在批准隔离目录的 release-1.9.6/。正式数据库、现有同步计划和本机运行服务均未操作。
