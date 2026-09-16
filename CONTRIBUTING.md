# 贡献指南

感谢关注 Token Watcher！这是一个本地多源 AI Agent 用量统计工具，最容易也最有价值的贡献方向是**接入新的数据源**。

## 添加一个新数据源

前提：该工具在本机留有含 token 用量的本地记录（transcript/数据库）。网页版应用（服务端计数的）无法接入。

0. **先做可行性判定**：逐请求用量必须以**可解析**的形式落地。找不到就不要接——一个靠猜字段写出来的
   采集器会变成"永远报 0 却在健康面板显示正常"的假数据源，比不接更有害。
   反面案例见 `docs/ARCHITECTURE.md` 的 Antigravity 一节（载荷加密，判定为当前不可接入）。

1. **调研格式**：找到数据文件，确认 usage 字段位置、口径（input 是否含缓存、reasoning 是否已含在 output 内）、
   模型名字段、时间戳格式与单位。口径结论要用原始数据验证，例如逐条核对
   `total == input + cacheRead + cacheWrite + output` 是否成立
2. **写 collector**（`src/collectors/<tool>.js`），实现统一接口：

```js
export async function collectXxxFile(store, { tool, path, fileId, offset, state, version }) {
  // 返回 { newOffset, inserted, state }
  // 事件：store.insertEvent({ ts, tool, model, session_id, project,
  //   input_tokens, cached_input, cache_write, output_tokens, reasoning_tokens,
  //   total_tokens, dedup_key })
  // 工具调用：store.insertToolCall({ ts, tool, name, session_id, dedup_key })
}
```

   要点：模型名过 `normalizeModel()`；`dedup_key` 全局唯一且重放幂等；若用 state 保存跨次解析状态，**必须写入 `_v = version`**（否则常驻服务每轮全量重扫）

3. **注册**（`src/config.js` 的 `SOURCES`）：tool 名、roots、kind（`jsonl`/`sqlite`/`zst`）、collector、version
4. **前端登记**：`web/lib/theme.js` 的 `TOOL_COLORS`/`TOOL_LABEL` 各加一项，`web/style.css` 加 badge 配色。
   配色别凭眼挑：新色要在深色底上与既有各色算 CIEDE2000（含红盲/绿盲模拟），标准是
   **加入后全集的最差配对不比现状更差**。测试里有一条断言会拦住"加了源却忘了登记配色/标签"。
   （健康列表不用管，它从 `SOURCES` 推导。）
5. **补测试**（`test/run.mjs`）：在临时 HOME 下加 fixture，断言黄金数字、dedup 幂等、project 归属、
   工具调用；增量类源再补一条"续写/删行后仍正确"的用例。判断测试是否够格的办法是把实现改坏一行，
   看它会不会变红——不会变红的测试等于没写。
6. **对账**：写独立脚本（Python 等）直接重算原始文件，与 `tokenwatcher scan` 后的库内数字精确比对，
   把结果贴进 PR。数量对不上要能解释清楚（例如全 0 用量的空调用被 `total <= 0` 跳过）

## 采集逻辑升级（已有源）

改完 collector 后把 `config.js` 里对应源的 `version` +1——版本机制会自动对存量文件全量重扫回填（dedup 保证幂等）。

### 上游换了格式：最隐蔽的一类故障

采集器**不会**因为解析不出东西而报错。上游改了记录类型或字段路径，表现是"扫描正常、退出码 0、
入库 0 条"——面板上那个源就是一条平线，看起来像"最近没用"。dsh 曾这样静默归零整整一个月
（详见 `docs/ARCHITECTURE.md` 的 dsh 段）。文件发现通常按扩展名通配，所以连"找不到文件"
都不会发生，日志里一切正常。

排查与防范：

- 怀疑时先跑一次 `SELECT tool, MAX(ts), COUNT(*) FROM events GROUP BY tool`。某个源的
  `MAX(ts)` 停在一个整齐的时间点，基本就是那天上游改了格式
- 到数据目录对比新旧文件名与 `mtime`：并存的新旧两份文件里，旧的冻结时刻就是断点
- 改完务必让**新旧两种结构各有一份 fixture**，旧格式那份是防止"修好新的、改坏旧的"
- 新结构的 `dedup_key` 要与旧结构隔开命名空间。迁移期两份文件常并存于同一目录，而会话键
  多为父目录名，序号撞上就会互相顶掉；旧结构的键则须保持原样，否则重扫时历史事件会被
  当成新行再插一遍

## 其他约定

- 零依赖原则：后端只用 Node 内置模块（`node:sqlite`/`node:http`/`node:fs`）；前端零构建（vanilla JS + ECharts UMD）
- 提交信息用中文或英文均可，说清"改了什么、为什么"即可
- 新源请注意隐私：只读、不上传、统计库不存对话内容
