# 贡献指南

感谢关注 Token Watcher！这是一个本地多源 AI Agent 用量统计工具，最容易也最有价值的贡献方向是**接入新的数据源**。

## 添加一个新数据源

前提：该工具在本机留有含 token 用量的本地记录（transcript/数据库）。网页版应用（服务端计数的）无法接入。

1. **调研格式**：找到数据文件，确认 usage 字段位置、口径（input 是否含缓存）、模型名字段、时间戳格式与单位
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
4. **前端**：`web/app.js` 的 `TOOL_COLORS`/`TOOL_LABEL` 加一项，`web/style.css` 加 badge 配色，`src/server.js` 的健康列表加 tool 名
5. **对账**：写独立脚本（Python 等）直接重算原始文件，与 `tokenmeter scan` 后的库内数字精确比对，把结果贴进 PR

## 采集逻辑升级（已有源）

改完 collector 后把 `config.js` 里对应源的 `version` +1——版本机制会自动对存量文件全量重扫回填（dedup 保证幂等）。

## 其他约定

- 零依赖原则：后端只用 Node 内置模块（`node:sqlite`/`node:http`/`node:fs`）；前端零构建（vanilla JS + ECharts UMD）
- 提交信息用中文或英文均可，说清"改了什么、为什么"即可
- 新源请注意隐私：只读、不上传、统计库不存对话内容
