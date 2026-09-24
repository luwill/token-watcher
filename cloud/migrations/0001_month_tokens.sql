-- 仅用于升级已有数据库，执行一次；新库使用 schema.sql。
-- 保留既有记录；NULL 不进入近 30 日榜，等待客户端上报完整窗口。
ALTER TABLE players ADD COLUMN month_tokens INTEGER;
CREATE INDEX IF NOT EXISTS idx_players_month_tokens ON players(month_tokens);
