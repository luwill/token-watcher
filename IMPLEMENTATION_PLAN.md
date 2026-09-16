# 修复 token 统计与官方口径的三处偏差

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

- [ ] 测试：v3 夹具（zstd CLI 压缩，缺失时守卫跳过），断言用量入库
- [ ] 实现：解析 `assistant/message` + `data.usage`，补 `cacheWriteTokens`，
      模型兼容 `data.message.source.model`
- [ ] 旧格式并存：同目录下新旧文件共用父目录名作 fileId，`dedup_key` 命名空间会撞车，需隔离

## 阶段 3：峰谷价未实现

`pricing.js` 只有注释写着"峰时价（谷时减半）"，没有任何代码，谷时用量被高估一倍。
方向与前两个 bug 相反，此前被掩盖。

- [ ] 确认官方谷时时段的准确定义（不靠记忆）
- [ ] 测试 + 实现

## 约束

- 改采集器须升 `version` → 触发全量重扫、重写正式库（已获用户确认）
- 每个 commit 独立通过全部测试
