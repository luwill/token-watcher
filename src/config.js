import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { normalizeExtraRoot } from './rootPaths.js';
import { coworkRoots, matchClaudeFile, descendClaudeDir } from './claudePaths.js';

export const HOME = homedir();

/**
 * 数据源注册表。
 * kind: jsonl  —— 递归扫描 *.jsonl（transcript 流式追加，字节游标增量；可用 match 收窄文件名）
 *       sqlite —— 单个 db 文件（rowid 水位增量，只读并发）
 *       zst    —— 递归扫描 *.zst（原子快照，mtime 变化即整体重解析 + dedup）
 *       poller —— 非文件源（账号级 API 轮询，见 src/cursorUsage.js）：无 roots，仅为
 *                  健康表/前端登记工具名；事件由 poller 直接入库
 * version: 采集器逻辑版本；files.state_json._v 落后时会自动全量重扫补数据（dedup 幂等）。
 */
/**
 * OpenCode 的库位置随 XDG 规范走（实测自其可执行体内的字符串常量：
 * XDG_DATA_HOME / XDG_CONFIG_HOME / LOCALAPPDATA / .local/share）：
 *   Linux、macOS：$XDG_DATA_HOME 或 ~/.local/share
 *   Windows：%LOCALAPPDATA%
 * 几个候选全部登记，不存在的会被枚举阶段跳过；去重是因为 XDG_DATA_HOME 常被显式设成默认值，
 * 重复的 root 会让同一个库在一轮里被扫两遍。
 */
function opencodeDbPaths() {
  const bases = [process.env.XDG_DATA_HOME, join(HOME, '.local/share'), process.env.LOCALAPPDATA];
  return [...new Set(bases.filter(Boolean).map(b => join(b, 'opencode', 'opencode.db')))];
}

/**
 * apiBilled：该源的用量是否计入"你自己的 API key 余额"。
 *
 * 只有标了的源才参与余额对账（`computeRecon`）。ccmr 是路由器，会把请求分发到
 * DeepSeek / Kimi / GLM 等多个厂商，所以归属维度是"用谁的钱包"而非"哪个厂商"——
 * 具体厂商由模型 id 前缀决定。未标注的源要么走订阅（claude-code / codex / grok），
 * 要么走自家积分（workbuddy），不扣你的 key，计进去就是虚高。
 * 拿不准的源宁可不标：少算会显示成缺口（看得见），多算会掩盖真实缺口（看不见）。
 */
export const SOURCES = [
  {
    tool: 'claude-code',
    label: 'Claude Code',
    roots: [join(HOME, '.claude/projects'), ...coworkRoots(HOME)],
    kind: 'jsonl',
    collector: 'claude',
    version: 3, // v3: Cowork discovery/audit fallback and cross-format message identity
    match: matchClaudeFile,
    descend: descendClaudeDir,
    subscription: true,
  },
  {
    tool: 'ccmr',
    label: 'ccmr',
    roots: [join(HOME, '.claude-gateway/projects')],
    kind: 'jsonl',
    collector: 'claude',
    // v3: 网关不写 requestId，一次响应的多个 content block 塌成同一 dedup_key，
    // 输出曾被钉死在首个分片的 0；修复后需全量重扫补正存量行
    version: 3,
    apiBilled: true, // 路由器用你自己的各厂商 API key，用量计入余额对账
  },
  {
    tool: 'codex',
    label: 'Codex',
    roots: [join(HOME, '.codex/sessions'), join(HOME, '.codex/archived_sessions')],
    kind: 'jsonl',
    collector: 'codex',
    // v4: 子代理/分叉文件开头重放的父会话历史不再计入；单次用量改取 last_token_usage。
    // v5: 识别 .jsonl.zst/.jsonl.zstd 快照；路径后缀归一后与普通及归档副本共用去重键。
    version: 5,
    match: (name) => name.endsWith('.jsonl') || name.endsWith('.jsonl.zst') || name.endsWith('.jsonl.zstd'),
    subscription: true,
  },
  {
    tool: 'zcode',
    label: 'ZCode',
    roots: [join(HOME, '.zcode/cli/db/db.sqlite')],
    kind: 'sqlite',
    collector: 'zcode',
    version: 2, // v2: 提取 tool_usage
    subscription: true,
  },
  {
    tool: 'dsh',
    label: 'dsh',
    roots: [join(HOME, '.dsh/sessions')],
    kind: 'zst',
    collector: 'dsh',
    // v2: 认 v3 会话结构（assistant/message + data.usage）。2026-08-14 dsh 切格式后
    //     本源静默归零一个月，升版触发全量重扫补回这段时间的用量
    // v3: 1.4.1 的内置 zstd 只解首帧，解析不出内容却照常推进游标，把"已处理"的
    //     假象写进了库。仅修解压不会回头重读——从 1.4.1 升级上来的用户游标都被
    //     污染了，必须靠升版强制全量重扫才能补回。
    // v4: chunk/message 与新旧快照按 session + turn + step 去重；重扫迁移旧行键。
    version: 4,
    apiBilled: true, // 与 ccmr 花的是同一个 DeepSeek 账户
  },
  {
    tool: 'grok',
    label: 'Grok Build',
    roots: [join(HOME, '.grok/sessions')],
    kind: 'jsonl',
    collector: 'grok',
    version: 1,
    subscription: true,
  },
  {
    tool: 'workbuddy',
    label: 'WorkBuddy',
    roots: [join(HOME, '.WorkBuddy/projects')],
    kind: 'jsonl',
    collector: 'workbuddy',
    version: 1,
    subscription: true,
  },
  {
    tool: 'pi',
    label: 'Pi',
    roots: [join(HOME, '.pi/agent/sessions')],
    kind: 'jsonl',
    collector: 'pi',
    version: 1,
  },
  {
    tool: 'opencode',
    label: 'OpenCode',
    roots: opencodeDbPaths(),
    kind: 'sqlite',
    collector: 'opencode',
    version: 2, // v2: message 改按 time_updated 增量（rowid 水位漏掉"先插后改"的消息），重扫补回
  },
  {
    tool: 'antigravity',
    label: 'Antigravity',
    // IDE / cli /（历史）ide 三个 variant 的 brain 目录都可能有会话；只收 transcript*.jsonl
    roots: [join(HOME, '.gemini', 'antigravity', 'brain'),
            join(HOME, '.gemini', 'antigravity-cli', 'brain'),
            join(HOME, '.gemini', 'antigravity-ide', 'brain')],
    kind: 'jsonl',
    collector: 'antigravity',
    version: 3, // v3: 逐轮真实 usage（含缓存）；旧日志按完整上下文估算，重扫覆盖旧差分
    match: (name) => name.startsWith('transcript') && name.endsWith('.jsonl'),
    subscription: true,
  },
  {
    tool: 'kimi',
    label: 'Kimi Code',
    roots: [join(HOME, '.kimi-code', 'sessions')],
    kind: 'jsonl',
    collector: 'kimi',
    version: 1,
    match: (name) => name === 'wire.jsonl',
    subscription: true,
  },
  {
    tool: 'qoder',
    label: 'Qoder',
    // 国际版与 CN 版（2026-08+ 起独立目录）都登记
    roots: [join(HOME, '.qoder', 'projects'), join(HOME, '.qoder-cn', 'projects')],
    kind: 'jsonl',
    collector: 'qoder',
    version: 1,
    subscription: true,
  },
  {
    tool: 'cursor',
    label: 'Cursor',
    // 账号级 CSV 轮询（src/cursorUsage.js），非本地文件源——占位让健康表/前端登记它
    roots: [],
    kind: 'poller',
    collector: null,
    version: 1,
    subscription: true,
  },
  {
    tool: 'hermes',
    label: 'Hermes',
    // Hermes Agent（Nous Research）：~/.hermes/state.db 的 session_model_usage（用量，原地累加，
    // 按 last_seen 水位）+ messages.tool_name（工具调用）。粒度为会话×模型×任务级聚合，
    // 上游不暴露逐请求明细（messages.token_count 全 0），如实呈现不造假。
    roots: [join(HOME, '.hermes/state.db')],
    kind: 'sqlite',
    collector: 'hermes',
    version: 1,
    watchRecursive: false, // ~/.hermes 顶层含 venv/缓存等数 GB 内容，只监听直接子项（-wal 在内）
  },
];

/**
 * 离线模式（TOKENMETER_OFFLINE=1）：完全不发外网请求。
 * 服务平时会访问三类外部端点——汇率接口、LiteLLM 牌价表、厂商余额接口（带 API key），
 * 离线时全部跳过，改用本地缓存 / pricing.json 的手动汇率 / 种子价继续出数。
 * 运行期读取，便于测试与用户临时切换。
 */
export const isOffline = () => process.env.TOKENMETER_OFFLINE === '1';

export const DATA_DIR = join(HOME, '.tokenmeter');
export const DB_PATH = join(DATA_DIR, 'tokenmeter.db');

/**
 * 本机扩展 root（~/.tokenmeter/extra-roots.json，可选）：给内置源追加扫描目录，如
 *   { "claude-code": ["~/.tokenmeter/remote/vps/claude/projects"] }
 * 场景：把另一台机器（VPS/家里电脑）上的 ~/.claude/projects 用任意传输（rsync/SSH、
 * Syncthing、手动拷贝）镜像到本机后并入统计。dedup_key 全局唯一：两台机器各自的会话
 * 自然并存，重复搬运的内容也只计一次。该文件只存在于配置它的那台机器上——个人配置
 * 留在数据目录，不进仓库与发布物。目录暂不存在不算错误（镜像还没同步过/外置盘未
 * 挂载），枚举阶段会自然跳过；修改后需重启服务才生效（config 在进程启动时读取一次）。
 */
export const EXTRA_ROOTS = {}; // tool -> [实际生效的追加路径]（供 doctor / CLI 展示）
function applyExtraRoots(sources) {
  let map;
  try {
    map = JSON.parse(readFileSync(join(DATA_DIR, 'extra-roots.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`extra-roots.json 无法解析，已忽略：${err.message}`);
    return;
  }
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    console.warn('extra-roots.json 应为 {"<tool>": ["绝对路径"]} 对象，已忽略');
    return;
  }
  for (const [tool, roots] of Object.entries(map)) {
    const src = sources.find(s => s.tool === tool);
    if (!src) { console.warn(`extra-roots.json：未登记的工具 "${tool}"，已忽略`); continue; }
    if (src.kind === 'poller') { console.warn(`extra-roots.json：${tool} 是账号级轮询源，无本地目录可扩展`); continue; }
    if (!Array.isArray(roots)) { console.warn(`extra-roots.json：${tool} 的值应为路径数组，已忽略`); continue; }
    for (const raw of roots) {
      const r = normalizeExtraRoot(raw, HOME);
      if (!r) { console.warn(`extra-roots.json：${tool} 的路径不是有效绝对路径，已忽略`); continue; }
      if (!src.roots.includes(r)) {
        src.roots.push(r);
        (EXTRA_ROOTS[tool] ??= []).push(r);
      }
    }
  }
}
applyExtraRoots(SOURCES);
/**
 * 默认端口可用 TOKENMETER_PORT 覆盖（写进 LaunchAgent / 容器 / 测试环境时免 --port）。
 * serve 在"未显式指定 --port"时遇占用会自动向后尝试（见 bin/tokenwatcher.js）。
 */
export const DEFAULT_PORT = (() => {
  const p = Number(process.env.TOKENMETER_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 8787;
})();
export const WEB_DIR = join(import.meta.dirname, '..', 'web');
/**
 * ECharts 的磁盘路径。
 *
 * 不能写死 `<本包>/node_modules/echarts`：那只在仓库里直接跑时成立。作为依赖被安装时
 * （npx / npm i -g），npm 会把 echarts 提升到顶层 node_modules，嵌套路径根本不存在，
 * 于是 /vendor/echarts.min.js 返回 404 → echarts 全局缺失 → app.js 在 echarts.init
 * 处抛错 → 整个面板空白。1.2.0 就是这么坏的。
 *
 * 交给 Node 自己的解析算法：提升与嵌套两种布局都能找到。
 */
function resolveEcharts() {
  try {
    return createRequire(import.meta.url).resolve('echarts/dist/echarts.min.js');
  } catch {
    // 兜底：echarts 未安装时给出仓库内的预期路径，由 serveFile 统一报 404
    return join(import.meta.dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js');
  }
}

export const ECHARTS_PATH = resolveEcharts();
