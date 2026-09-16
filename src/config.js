import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

export const HOME = homedir();

/**
 * 数据源注册表。
 * kind: jsonl  —— 递归扫描 *.jsonl（transcript 流式追加，字节游标增量）
 *       sqlite —— 单个 db 文件（rowid 水位增量，只读并发）
 *       zst    —— 递归扫描 *.zst（原子快照，mtime 变化即整体重解析 + dedup）
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
    roots: [join(HOME, '.claude/projects')],
    kind: 'jsonl',
    collector: 'claude',
    version: 2, // v2: 提取 tool_use 工具调用
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
    version: 3, // v3: state 记录 parent_thread_id（resume 链模型继承）
  },
  {
    tool: 'zcode',
    label: 'ZCode',
    roots: [join(HOME, '.zcode/cli/db/db.sqlite')],
    kind: 'sqlite',
    collector: 'zcode',
    version: 2, // v2: 提取 tool_usage
  },
  {
    tool: 'dsh',
    label: 'dsh',
    roots: [join(HOME, '.dsh/sessions')],
    kind: 'zst',
    collector: 'dsh',
    // v2: 认 v3 会话结构（assistant/message + data.usage）。2026-08-14 dsh 切格式后
    // 本源静默归零一个月，升版触发全量重扫补回这段时间的用量
    version: 2,
    apiBilled: true, // 与 ccmr 花的是同一个 DeepSeek 账户
  },
  {
    tool: 'grok',
    label: 'Grok Build',
    roots: [join(HOME, '.grok/sessions')],
    kind: 'jsonl',
    collector: 'grok',
    version: 1,
  },
  {
    tool: 'workbuddy',
    label: 'WorkBuddy',
    roots: [join(HOME, '.WorkBuddy/projects')],
    kind: 'jsonl',
    collector: 'workbuddy',
    version: 1,
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
    version: 1,
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
export const DEFAULT_PORT = 8787;
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
