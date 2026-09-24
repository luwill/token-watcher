-- token-watcher 社区排行榜 D1 表结构
-- 部署：wrangler d1 execute token-watcher-leaderboard --file=schema.sql（见 cloud/README.md）

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,                     -- 客户端一次性生成的随机 UUID（无机器指纹）
  name TEXT NOT NULL,                      -- 清洗后的昵称（1-16 码点，无链接/@/黑名单词）
  day TEXT,                                -- UTC 自然日 YYYY-MM-DD
  day_tokens INTEGER NOT NULL DEFAULT 0,
  day_requests INTEGER NOT NULL DEFAULT 0,
  week_tokens INTEGER NOT NULL DEFAULT 0,
  month_tokens INTEGER,                   -- 滚动 30 天；NULL 表示旧客户端未上报
  roi_ratio REAL,                          -- 订阅 ROI 比值（只存 ×N，不存金额）
  models_json TEXT,                        -- [[模型, 占比%], ...] ≤8 条
  models_by_period_json TEXT,              -- {day, week, month}: 各周期主力模型与占比
  tools_json TEXT,                         -- [[工具, 占比%], ...] ≤8 条
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_day_tokens ON players(day_tokens);
CREATE INDEX IF NOT EXISTS idx_players_week_tokens ON players(week_tokens);
CREATE INDEX IF NOT EXISTS idx_players_updated ON players(updated_at);
CREATE INDEX IF NOT EXISTS idx_players_month_tokens ON players(month_tokens);
