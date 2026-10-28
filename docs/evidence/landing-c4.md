# Landing C4：真实数据落地验证（2026-10-28）

方法（D2）：临时 HOME `/tmp/twm-real-home` + 软链真实设备目录，只读真实数据、写临时库。
真实库：`~/Library/Application Support/Doubao/Default/IndexedDB`（9 月冻结）、
`~/Library/Application Support/DoubaoWork/Default/IndexedDB`（在用，App 运行中）。

## 命令与输出

```
$ HOME=/tmp/twm-real-home USERPROFILE=/tmp/twm-real-home TOKENMETER_OFFLINE=1 TOKENMETER_NO_KEYCHAIN=1 \
    node --disable-warning=ExperimentalWarning bin/tokenwatcher.js scan
[token-watcher] scan: 26 files, +22 events in 0.3s
[token-watcher] doubao           21 次  in=2.06M cached=0 cacheW=0 out=0  total=2.06M
[token-watcher] doubaowork        1 次  in=104.2K cached=0 cacheW=0 out=0  total=104.2K
（二次 scan：+0 events，幂等）

$ … tokenwatcher.js doctor
  ✓ node v22.23.2（要求 ≥22.13）
  ✓ PRAGMA quick_check: ok
  ✓ /tmp/twm-real-home/.tokenmeter/tokenmeter.db（22 事件 / 2.2M tokens）
  ✓ 豆包           ok    事件      21
  ⚠ 豆包工作         stale 事件       1  文件在写但无新事件，疑似格式漂移
```

## 逐条核对（collector 语义在真实数据上成立）

- doubao 21 事件，in 合计 2.06M；model 全部 `doubao-model-38`（数字 id 归一）；
  project 为 workspace basename（TopBrain / ct-cardiology-neurology / null）；
  <redacted> `doubao:38439051721452546:536391640`）；
  output/cached/reasoning 全 0；ts 为 create_time_ms 毫秒。与 C2/C3 锁定的口径一致。
- doubaowork 1 事件（104.2K，model doubao-model-38，今日 08:56 任务）。
- 二次扫描 +0 事件：dedup 幂等成立。

## 豆包工作 stale 判定归因（非采集缺陷）

健康启发式（src/server.js:130-132）：文件 mtime 在 30 分钟内 **且** 比最后事件 ts 新 30 分钟以上 → stale。
- 采集时点：max_mtime=03:05:55Z（App 常驻写入，含 launcher/background/chat 三个 leveldb 的 WAL 与 blob），
  last_ts=00:56:14Z（08:56 任务），差值约 2h → 命中 stale。
- 直接核验当前 live WAL（000088.log）+ 新 .ldb（000090.ldb）：`context_window_usage` 0 命中，
  `total_window_size`/`used_tokens`/`create_time_ms` 均 0；conversation_id/doubao 大量存在 →
  最近写入是普通聊天/元数据记录，**不含任何未采集的 CWU 记录**——不是格式漂移，是共享启发式
  把「常驻聊天壳应用的普通写入」误读为「疑似漂移」。
- 结论：采集器正确（无漏采），stale 为既有启发式的已知噪音。冻结侧 doubao 因文件 mtime 陈旧 → ok，无此问题。

## C4 判定

- doubao ≥1 事件 ✓（21）；doubaowork 行存在、事件>0、无解析错误 ✓；
- 「doctor 两行正常」字面未达（豆包工作 ⚠ stale）→ 记为 erratum（见 run.md Criterion errata），
  人类落地时裁定；非阻塞（doctor 退出码 0，警示不阻断）。
- 提议 P2（人类裁定）：把 doubao/doubaowork 源 root 收窄到 `chrome_*-chat_0.indexeddb.leveldb` + 同名 blob，
  或对 leveldb 源把 stale 触发改为「目录有写且含可识别 CWU」——二者均属配置/逻辑改动，超出本次预授权范围，
  不静默实施。
