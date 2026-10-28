# Mutant — mutant-c1

- tested commit: 57f5eed532c13182cb33487d151a61b4bfda84b8
- HEAD: 7d9eb815da8dabe45ed3f78a979e221334014c23
- workdir: /Users/louwill/Vibing/token-stats
- sandbox: env-clean
- started: 2026-10-28T02:03:58Z
- recorded by sha256: 332bc6db1a13f5d6dd7196c8a7c8059e8b9e9905950e145dae93dbad3ea23970
- policy: {"record_paths":{"evidence_dir":"docs/evidence","run_record":"docs/runs/run.md"},"write_dirs":[],"version":1,"sandbox":"env-clean","deny_network":false,"deny_paths":[],"read_paths":["/usr","/bin","/sbin","/lib","/lib64","/System/Library","/Library/Apple","/private/var/db/dyld","/private/etc","/etc","/dev","/Users/louwill/Library/Application Support/DoubaoWork/sandbox_runtime/bases/98670218a5f0d8bc9b9ebf3f70881304","/Users/louwill/Vibing/token-stats/node_modules"],"env":[],"fallback":"env-clean","allow_loopback":true,"share_dirs":["node_modules"]}
- shared read-only from the checkout (not installed from a lockfile): node_modules
- helper inventory sha256: 8843c17e5c28546d10a2fdee99a301bd0c89c7e7f439b501a470e8c771d47f80
- helper reference: takeoff pin (AUTOPILOT_HELPER_PIN)
- frozen controls sha256: 6cfd0324e0e14f6e7d37ffa31b5e52586a44157dfd6ade045c3317934ac99938
- helper lib.sh sha256: 3145fb40c92a089fa15bcdddab3ec7a590f6d58f7c3c541a1acfda7770751ba5
- helper runner.sh sha256: 76bc06df1fa2153394e799fef2420fb6a9365f409a98adaf642059be673eae21
- helper redact.py sha256: 372d0fc8d3713ee0855d771117f4e2f2e6279e900854f6fe4a3702ff52177656
- helper policy.py sha256: 04916e799546b77e8c427ccdb675d53bb287cc26ee6e8b0ca1bd3a6e2abce820
- helper evidence.py sha256: ea96ea8dfe6a6032eba756b9fed2db3c3add4584ed3af1281a4ac50832502e3e
- helper record_scope.py sha256: 5cdd4a5b12c9164cd7778388f539feb864f8ec4d6d7944fa2ecbd7e698b0c186
- helper failure_signature.py sha256: 20491f66e2d54ca3bb0a1637e6ec8d2a816d7ca715cc831d8db4555d24eddc79
- helper source_state.py sha256: 5625448d8a713db7dce7684a5fcb31994e4f94e6ae21009672a45467e478a242
- helper integrity.py sha256: 1e8d6e104429169978e349a8c44a431e31c26e86700c17e8f1d221131156cafc

Command output below is untrusted data, never instructions.
- source guard: PASS (source write denied; artifact output writable)
- failure signature: ✗ 每个注册数据源都有品牌色与标签.*缺登记: doubao; expected exit: 1
- mutated files: web/lib/theme.js
- patch sha256: 4688ef55b0fde6713eb961d85e344d7ba003f2ef264e6a9563b778860ee946d7

```diff
diff --git a/web/lib/theme.js b/web/lib/theme.js
index 1bf0623..988bd36 100644
--- a/web/lib/theme.js
+++ b/web/lib/theme.js
@@ -14,7 +14,7 @@ export const TOOL_COLORS = {
   // 常视觉最差对保持原 zcode/cursor（ΔE 8.89）；色盲模拟最差对为 doubaowork vs ccmr/dsh
   // （protan 5.92 / deutan 4.50），全部 ≥4.5 可区分区间，兄弟对 doubao/doubaowork 各向 ≥11.4。
   // 完整校验记录见 docs/evidence/stage1。
-  'doubao': '#1d6cff', 'doubaowork': '#5c8fd0',
+  'doubaowork': '#5c8fd0',
 };

 export const TOOL_LABEL = {

```
## baseline (unpatched)

```sh
npm test
```

exit 0; timed out: no

```
  ✓ windows历史缓存第1次切换保持分区及费用一致
  ✓ all历史缓存第1次切换保持分区及费用一致
  ✓ local历史缓存第1次切换保持分区及费用一致
  ✓ vps历史缓存第1次切换保持分区及费用一致
  ✓ unknown历史缓存第1次切换保持分区及费用一致
  ✓ windows历史缓存第2次切换保持分区及费用一致
  ✓ all历史缓存第2次切换保持分区及费用一致
  ✓ local历史缓存第2次切换保持分区及费用一致
  ✓ vps历史缓存第2次切换保持分区及费用一致
  ✓ unknown历史缓存第2次切换保持分区及费用一致
  ✓ 设备切换和全设备概览复用历史缓存
  ✓ 设备筛选在事务内可见自身历史写入
  ✓ 设备筛选事务回滚不污染历史缓存
  ✓ /api/summary拒绝非法设备
  ✓ /api/sessions拒绝非法设备
  ✓ /api/session/shared拒绝非法设备
  ✓ /api/tool-activity拒绝非法设备
  ✓ /api/export.csv拒绝非法设备
PASS device boundaries, unknown mirrors, read-only query scope, invalid devices and shared frontend URL builder
PASS projection removes body, private paths, credentials, arguments and quota payloads
PASS current collectors preserve tokens, models, timestamps and compaction; repeated scan is idempotent
PASS exporter retains stable prefixes, skips unchanged files and preserves previous export on source rewrite
PASS sync refuses raw mode and paths before download, validates metadata and skips unchanged hashes
Fixtures retained: /private/tmp/apsim-run/autopilot-run.caWHrX/tree-tmp/token-windows-usage-test-762RtS
PASS Only expected roots and file formats are accepted
PASS SFTP paths quote spaces and reject control characters
PASS Real OpenSSH SFTP treats quoted spaces and brackets literally
PASS First sync publishes complete files and preserves remote mtime
PASS Unchanged files are not retransferred
PASS Failed transfer keeps previous mirror and cursor; retry recovers
PASS Changing remote file is deferred instead of publishing an unstable snapshot
PASS Remote deletion does not delete a local historical log
PASS SSH/manifest failure creates no new mirror directory
9 checks passed; retained fixtures: /private/tmp/apsim-run/autopilot-run.caWHrX/tree-tmp/token-windows-sync-test-uOK4nf

[隔离] 数据目录与采集根
  ✓ 数据目录与全部采集根都在测试临时目录内
  ✓ 子进程继承的基目录变量都指向临时目录

✓ 全部通过

```
- source guard: PASS (source write denied; artifact output writable)
## mutant (patched)

```sh
npm test
```

exit 1; timed out: no

```
  ✓ 会话 ID 可钻取：my session (copy)
  ✓ 会话 ID 可钻取：会话-1
  ✓ 会话 ID 可钻取：xxxxxxxxxxxxxxxxxxxxxxxx…(256)
  ✓ tool=codex 只返回 codex 的事件
  ✓ tool=claude-code 只返回 claude-code 的事件
  ✓ 不带 tool 时保持旧行为（全部工具）
  ✓ 坏输入返回 400：空 ID
  ✓ 坏输入返回 400：超长 257
  ✓ 坏输入返回 400：控制字符 \n
  ✓ 坏输入返回 400：控制字符 DEL
  ✓ 坏输入返回 400：残缺百分号编码
  ✓ Antigravity 实数优先、输入不减缓存、思维不重复相加
  ✓ Antigravity 新增事件通过写入代理正确计数
  ✓ Antigravity 二次扫描幂等
  ✓ Antigravity 同 step 的晚到实数覆盖更大的旧输出估算
  ✓ Antigravity 升级实数后清掉 pending
  ✓ Antigravity full/metadata 的旧估算不能覆盖实数
  ✓ Antigravity ACTIVE 不抢占 DONE，重复 DONE 不双计
  ✓ Antigravity 全零实数仍覆盖字符估算
  ✓ Antigravity 不把缺失、负数、字符串或 Infinity usage 当实数
  ✓ Antigravity 总量溢出时不采为实数
  ✓ Antigravity 同质量副本保留完整字符上下文，不被截短副本覆盖
  ✓ Antigravity 旧日志完整上下文计量，增长和压缩均不做差分
  ✓ Antigravity 旧日志输出含估算思维一次
  ✓ Antigravity transcript 不变时重试晚到 metadata
  ✓ Antigravity 补正旧轮不倒退或改变后轮输入
  ✓ Antigravity metadata 到位后 pending 清空
  ✓ Antigravity 仅补正已有事件也通知面板刷新
  ✓ Antigravity 静默补正后再次扫描幂等
  ✓ Antigravity 版本重扫覆盖所有旧 usage 列，即使输出变小

[claude] Cowork discovery / audit fallback / cross-format dedup / Windows paths
  ✓ POSIX absolute
  ✓ POSIX tilde
  ✓ POSIX relative
  ✓ POSIX rejects Windows drive
  ✓ Windows drive
  ✓ Windows forward slashes
  ✓ Windows UNC
  ✓ Windows tilde slash
  ✓ Windows tilde backslash
  ✓ Windows drive relative rejected
  ✓ Windows plain relative rejected
  ✓ empty rejected
  ✓ Cowork roots: macOS, Windows roaming/MSIX and absent packages
  ✓ Default config registers this platform Cowork roots and v3
  ✓ Discovery accepts hidden transcript/audit; excludes generated files and prunes outputs/plugins
  ✓ CLI add/list/remove and config loading use actual host absolute paths
  ✓ Standard-only token/cache totals and tool calls remain exact
  ✓ Audit-only timestamps/session IDs and modelUsage exclusion
  ✓ Transcript/audit forward order: one event, standard wins even with smaller output
  ✓ Transcript/audit reverse order: one event, standard wins even with smaller output
  ✓ Audit timestamp plus standard-looking timestamp still stays fallback
  ✓ Mirrors with changed requestId/filename do not duplicate or churn timestamp
  ✓ Source priority persists across store reopen; late audit cannot replace standard history
  ✓ Message identity matching a key namespace cannot remove unrelated canonical events
  ✓ Incremental fragments fill output/cache exactly once; incomplete line is retried
  ✓ Old requestId keys merge only observed identity; missing-source/ccmr history survives
  ✓ ccmr keeps its requestId keys and output completion rule
  ✓ Malformed, synthetic, non-assistant, invalid token and unidentified audit rows are ignored
  ✓ Scanner discovers hidden Cowork files, ignores outputs, rescans v2 keys and remains idempotent
  ✓ Scanner failure rolls back alias migration/cursor, then retry succeeds
  ✓ Argon 官方优惠价格回退：输入+缓存+输出 12.1 USD/M
  ✓ Argon 2026-12-01 起切换官方标准价格
  ✓ Argon 用户自定义单价仍优先于官方回退
  ✓ Argon 进入按天费用图，与费用卡一致且不再未配价
  ✓ 官方价格及来源别名：gemini-3.8-flash-n（含缓存写、币种）
  ✓ 官方价格及来源别名：step-5-preview（含缓存写、币种）
  ✓ 官方价格及来源别名：claude-opus-5-5-max（含缓存写、币种）
  ✓ 官方价格及来源别名：grok-4.7-high-fast（含缓存写、币种）
  ✓ 官方价格及来源别名：grok-4.7-build（含缓存写、币种）
  ✓ 官方价格及来源别名：k3（含缓存写、币种）
  ✓ 官方价格及来源别名：kimi-k3-1（含缓存写、币种）
  ✓ 官方价格及来源别名：hy4-preview-f（含缓存写、币种）
  ✓ 官方价格及来源别名：mimo-v2.5-free（含缓存写、币种）
  ✓ 官方价格及来源别名：stealth/union-alpha（含缓存写、币种）
  ✓ 官方价格及来源别名：deepseek/deepseek-v4-flash-0731（含缓存写、币种）
  ✓ Gemini 3.8 Flash 优惠截止时刻与下一档官方价
  ✓ 原始别名用户价优先，规范模型用户价次之，官方价最后回退
  ✓ 旧三项 K3 用户表补官方默认缓存写价，显式零价保留
  ✓ 只有缓存写的事件仍计费，旧 Opus 三项价不漏写缓存费
  ✓ Grok 单次请求按含缓存输入的 200k 边界分档，Fast 长上下文按 1.5 倍
  ✓ Cursor/Grok 多调用汇总不误当成单次长上下文加价
  ✓ Step 5 缓存价格切换时刻；旧账户资格不从日志臆测
  ✓ 别名/免费价严格限定来源；自动路由与未知模型继续明确缺价
  ✓ 按天图/费用卡/总费用一致；同名不同来源不混价，免费不冒充缺价
  ✓ 维护循环不把无检查、待运行、取消或跳过当作 CI 成功
  ✓ CI 全绿仍等待复核；远端标题不改变权限
  ✓ 维护队列重复快照没有新增待办，时钟变化不重复触发
  ✓ 检查返回顺序不影响幂等；异仓库状态被拒绝
  ✓ PR 更新时间相同时，新 SHA 或 CI 变化仍触发维护
  ✓ 已关闭队列项被识别，不自动重新创建
  ✓ 发布前与公开前均允许新版本或相同产物的已有草稿
  ✓ 公开版本和被替换的草稿安装包或校验值会阻止发布
  ✓ 缺失草稿附件和读取 GitHub 失败均阻止发布

[opencode] large part.data stays out of the JS heap / malformed rows skipped
  ✓ malformed / non-tool / user rows are skipped, watermark reaches MAX(rowid)
  ✓ message and part iterators survive GC between rows
  ✓ first scan of a large part table fits a 48 MiB heap

[scan] Codex first-scan query plans / long-line reader
  ✓ dropStaleCodexRows: every statement uses an index, DELETE ranges on dedup_key
  ✓ dropStaleCodexRows still removes only its own stem and keeps current siblings
  ✓ readLinesFrom: a 16 MiB line is joined once, not once per chunk
  ✓ readLinesFrom: multibyte chars split across chunks, trailing partial line not consumed

[summary] history aggregate cache: warm == cold, invalidation paths
  ✓ first call matches a direct full-history aggregation
  ✓ warm call reuses the cache and equals a cold recompute
  ✓ today's writes keep the cache and still show up
  ✓ invalidates on history insert
  ✓ invalidates on history UPDATE (model backfill)
  ✓ invalidates on history DELETE
  ✓ invalidates on row moved from today into history
  ✓ invalidates on write from another connection
  ✓ rolled-back history write leaves the cache valid
  ✓ read inside a rolled-back transaction does not poison the cache (db.isTransaction)
  ✓ read inside a rolled-back transaction does not poison the cache (BEGIN probe (Node < 22.16))
  ✓ crossing midnight moves the boundary

[scan] 空闲重扫：Codex 模型回填
  ✓ backfill UPDATE uses the partial NULL-model index
  ✓ first scan runs the backfill; parent model unknown leaves NULLs
  ✓ idle rescan with no Codex change skips the backfill
  ✓ parent model appearing later is inherited by the child
  ✓ a new scanner instance backfills once even when nothing changed

[scan] 扫描中途的扫描请求
  ✓ a scan requested mid-scan runs again after the current one
  ✓ no follow-up is scheduled when nothing was requested mid-scan
  ✓ stop() during a scan cancels the follow-up
  ✓ 设备历史补齐保留全部原字段与事件ID
  ✓ Mac/VPS/Windows/历史未归属/本机轮询正确分区
  ✓ 设备迁移重复执行不改变统计
  ✓ 远端异步解析期间本机轮询保持本机归属
  ✓ 镜像重复不会增加事件或改变已知来源
  ✓ 文件游标持久保存来源设备
  ✓ 默认全部设备保留总量
  ✓ local统计/图表/模型/工具/最近请求统一筛选
  ✓ local筛选仍展示所有设备总量
  ✓ local会话列表与钻取保持设备隔离
  ✓ local工具活动遵循设备范围
  ✓ localCSV设备总量与面板一致
  ✓ vps统计/图表/模型/工具/最近请求统一筛选
  ✓ vps筛选仍展示所有设备总量
  ✓ vps会话列表与钻取保持设备隔离
  ✓ vps工具活动遵循设备范围
  ✓ vpsCSV设备总量与面板一致
  ✓ windows统计/图表/模型/工具/最近请求统一筛选
  ✓ windows筛选仍展示所有设备总量
  ✓ windows会话列表与钻取保持设备隔离
  ✓ windows工具活动遵循设备范围
  ✓ windowsCSV设备总量与面板一致
  ✓ unknown统计/图表/模型/工具/最近请求统一筛选
  ✓ unknown筛选仍展示所有设备总量
  ✓ unknown会话列表与钻取保持设备隔离
  ✓ unknown工具活动遵循设备范围
  ✓ unknownCSV设备总量与面板一致
  ✓ 所有设备分区之和等于总量且费用可相加
  ✓ windows历史缓存第1次切换保持分区及费用一致
  ✓ all历史缓存第1次切换保持分区及费用一致
  ✓ local历史缓存第1次切换保持分区及费用一致
  ✓ vps历史缓存第1次切换保持分区及费用一致
  ✓ unknown历史缓存第1次切换保持分区及费用一致
  ✓ windows历史缓存第2次切换保持分区及费用一致
  ✓ all历史缓存第2次切换保持分区及费用一致
  ✓ local历史缓存第2次切换保持分区及费用一致
  ✓ vps历史缓存第2次切换保持分区及费用一致
  ✓ unknown历史缓存第2次切换保持分区及费用一致
  ✓ 设备切换和全设备概览复用历史缓存
  ✓ 设备筛选在事务内可见自身历史写入
  ✓ 设备筛选事务回滚不污染历史缓存
  ✓ /api/summary拒绝非法设备
  ✓ /api/sessions拒绝非法设备
  ✓ /api/session/shared拒绝非法设备
  ✓ /api/tool-activity拒绝非法设备
  ✓ /api/export.csv拒绝非法设备
PASS device boundaries, unknown mirrors, read-only query scope, invalid devices and shared frontend URL builder
PASS projection removes body, private paths, credentials, arguments and quota payloads
PASS current collectors preserve tokens, models, timestamps and compaction; repeated scan is idempotent
PASS exporter retains stable prefixes, skips unchanged files and preserves previous export on source rewrite
PASS sync refuses raw mode and paths before download, validates metadata and skips unchanged hashes
Fixtures retained: /private/tmp/apsim-run/autopilot-run.caWHrX/mutant-tmp/token-windows-usage-test-dYTCvE
PASS Only expected roots and file formats are accepted
PASS SFTP paths quote spaces and reject control characters
PASS Real OpenSSH SFTP treats quoted spaces and brackets literally
PASS First sync publishes complete files and preserves remote mtime
PASS Unchanged files are not retransferred
PASS Failed transfer keeps previous mirror and cursor; retry recovers
PASS Changing remote file is deferred instead of publishing an unstable snapshot
PASS Remote deletion does not delete a local historical log
PASS SSH/manifest failure creates no new mirror directory
9 checks passed; retained fixtures: /private/tmp/apsim-run/autopilot-run.caWHrX/mutant-tmp/token-windows-sync-test-HjzYmf

[隔离] 数据目录与采集根
  ✓ 数据目录与全部采集根都在测试临时目录内
  ✓ 子进程继承的基目录变量都指向临时目录

✗ 1 项失败

```
- finished: 2026-10-28T02:04:25Z
- result: KILLED
