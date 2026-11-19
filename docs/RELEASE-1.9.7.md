# Token Watcher 1.9.7

- 新增 Hermes Agent 数据源。Token Watcher 只读采集 `~/.hermes/state.db` 中的会话与模型累计用量、缓存读写和工具调用。感谢 [Hpyjzss 提交 PR #22](https://github.com/luwill/token-watcher/pull/22)。
- 跨午夜继续同一会话时，已入账的用量留在原来的日期。例如首日为 1,000 tokens，次日累计升至 1,500，面板分别显示 1,000 和 500。重复扫描同一快照不会增加总量。
- Hermes 提供累计快照。首次采集或间隔多天才再次扫描时，期间新增用量归入源快照最后更新的本地日期，无法逐日拆分。
- 读取压缩日志时，缺少 zstd 的提示会按 Windows、Linux 或 macOS 给出相应安装方式。[PR #21](https://github.com/luwill/token-watcher/pull/21)

安装指定版本请运行 `npm install -g token-watcher@1.9.7`。最低 Node.js 版本为 22.13。
