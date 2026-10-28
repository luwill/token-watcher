# Stage 1 evidence — doubao / doubaowork 前端登记与配色校验

- stage: 1（前端登记完整化，C1）
- date: 2026-10-28
- 范围：`web/lib/theme.js` TOOL_COLORS/TOOL_LABEL、`web/app.js` LIGHT_TOOL_COLORS、`web/style.css` badge（深/浅）、`web/index.html` footer。
- 校验脚本（工作副本，非产物）：`/tmp/validate-cie.mjs`（全集 worst-pair 与对比度）、`/tmp/final-dark.mjs`（最终取值的精确配对表）、`/tmp/sweep-light.mjs`（浅色候选扫描）。
  脚本 sha256（用于复现口径识别）：

```
877ff62720adfc694aa098b797766452025e5bc9daad820efbede67dc9f80c74  /tmp/validate-cie.mjs
9ae798e54e6832ff87f7dcbaf24eec9b087d1f595a61a0a78b54861b4d5f2ed7  /tmp/final-dark.mjs
c4fc27efb23d4688108c1eb2518ae7074f7ceb270cdf675506a0c83f3b92edf5  /tmp/sweep-light.mjs
72c6566146f14a67301d6fd80d9770b379f672cd8be03cdf3fd9d5cd871e6dc6  /tmp/sweep-dwb.mjs
```

## 方法

- CIEDE2000（Sharma et al. 标准实现）：以官方测试向量自检通过 —— pair#1 = 2.0425、pair#25 = 1.0000（与发布值精确一致）。
- 色觉障碍模拟：Machado–Oliveira–Fernandes 2009 矩阵（protanopia / deuteranopia），对模拟后的颜色再算 CIEDE2000。
- 最差对 = 全集内两两 ΔE 最小者；分别按 normal / protan / deutan 三个视图报告。
- 徽章文字对比度：WCAG 2.x 相对亮度公式（深色底 `#14141c` / 白底 `#ffffff`）。

## 深色全集（15 色，底 #14141c）

加入 doubao `#1d6cff`、doubaowork `#5c8fd0` 前后对比：

| 视图 | 加入前最差对 (13 色) | 加入后最差对 (15 色) | 变化 |
|---|---|---|---|
| normal | 8.89（zcode #f2c14e / cursor #f2cc8f） | 8.89（同前） | 不变 |
| protan | 7.30（codex #34c98e / kimi #95d5b2） | 5.92（ccmr #8b7cf6 / doubaowork #5c8fd0） | 新对，≥5.9 可区分 |
| deutan | 5.00（ccmr #8b7cf6 / dsh #4ea8de） | 4.50（dsh #4ea8de / doubaowork #5c8fd0） | 新对，≥4.5 可区分 |

关键配对明细：

| 配对 | normal | protan | deutan |
|---|---|---|---|
| doubao #1d6cff ↔ doubaowork #5c8fd0 | 11.66 | 11.44 | 13.90 |
| doubaowork ↔ dsh #4ea8de | 9.93 | 5.92 | 4.50 |
| doubaowork ↔ ccmr #8b7cf6 | 13.83 | 5.92 | 4.53 |
| doubao ↔ ccmr | 13.07 | 7.72 | 13.51 |
| doubao ↔ dsh | 20.09 | 16.45 | 17.53 |

结论与如实说明：品牌蓝系 + 不动既有 dsh/ccmr 的约束下，无法做到“色盲视图最差对不劣于现状”（扫描 17 个候选蓝均如此，蓝色家族内与 dsh/ccmr 必有其一接近）。最终取 `#5c8fd0`：normal 视图最差对保持原 zcode/cursor（8.89）；protan/deutan 最差对为新配色自身（5.92 / 4.50），全部 ≥4.5（在 ~2.3 的“不可感知”JND 之上、可区分区间）；兄弟对 doubao/doubaowork 各向 ≥11.4，图例可辨。theme.js 注释按此实际数据撰写（不再声称“不劣于现状”）。

候选扫描摘要（doubao 固定 #1d6cff）：`#5b9bff`（初稿）deutan 2.75 不可用；`#3f7fd4` deutan 4.99 但 normal 兄弟对降至 7.77；`#5c8fd0` normal 8.89 / protan 5.92 / deutan 4.50，为平衡最优。

## 浅色全集（15 色，底 #ffffff）

加入 doubao-light `#1b4fd6`、doubaowork-light `#2c59ad` 前后对比：

| 视图 | 加入前最差对 (13 色) | 加入后最差对 (15 色) |
|---|---|---|
| normal | 3.95（zcode-light #8a6d15 / cursor-light #7d6412） | 3.95（同前） |
| protan | 0.37（opencode-light #bc5a10 / cursor-light #7d6412） | 0.37（同前） |
| deutan | 1.02（zcode-light #8a6d15 / opencode-light #bc5a10） | 1.02（同前） |

两新色未制造任何新的最差对（限制对均为既有的黄/橙系）。对比度：doubao-light #1b4fd6 = 6.70:1、doubaowork-light #2c59ad = 6.69:1（白底，均 ≥4.5:1）。

## 登记一致性（C1 断言相关）

- TOOL_COLORS / TOOL_LABEL / LIGHT_TOOL_COLORS / style.css badge（深+浅）/ index.html footer 五处均已含 doubao 与 doubaowork。
- `npm test` 的 theme 断言（每个注册数据源都有品牌色与标签）覆盖 TOOL_COLORS+TOOL_LABEL；LIGHT_TOOL_COLORS 与 badge 的同步由本证据的记录约束（代码注释互相指向）。
