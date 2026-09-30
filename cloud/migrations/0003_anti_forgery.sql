-- 仅用于升级已有数据库，执行一次；新库使用 schema.sql。
-- 防伪造：7 / 30 天改由服务端按天累加，封禁表。
ALTER TABLE players ADD COLUMN write_nonce TEXT;

CREATE TABLE IF NOT EXISTS daily (
  id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily(day);

CREATE TABLE IF NOT EXISTS banned (
  id TEXT PRIMARY KEY,
  reason TEXT,
  banned_at INTEGER NOT NULL
);

-- 迁移前已入库、按新规则会被拒收的记录（阈值同 lib.js PLAUSIBLE）直接清除：
-- 新规则只挡新上报，挡不住已经存进来的伪造数据。
DELETE FROM players WHERE day_tokens > 20000000000 OR day_requests > 200000
  OR (day_tokens > 0 AND day_requests < 1)
  OR (day_requests > 0 AND day_tokens * 1.0 / day_requests > 5000000);

-- 已有的 7 / 30 天是客户端自报的，可能是伪造的：以各自最近一天的上报为起点重新累计。
INSERT OR IGNORE INTO daily (id, day, tokens, updated_at)
  SELECT id, day, day_tokens, updated_at FROM players WHERE day IS NOT NULL AND day_tokens > 0;
UPDATE players SET week_tokens = day_tokens, month_tokens = day_tokens;
