import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();

/**
 * 数据源注册表。
 * kind: jsonl  —— 递归扫描 *.jsonl（transcript 流式追加，字节游标增量）
 *       sqlite —— 单个 db 文件（rowid 水位增量，只读并发）
 *       zst    —— 递归扫描 *.zst（原子快照，mtime 变化即整体重解析 + dedup）
 * version: 采集器逻辑版本；files.state_json._v 落后时会自动全量重扫补数据（dedup 幂等）。
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
    version: 2,
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
    version: 1,
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
export const ECHARTS_PATH = join(
  import.meta.dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js'
);
