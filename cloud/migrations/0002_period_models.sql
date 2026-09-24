-- 仅用于升级已有数据库，执行一次；新库使用 schema.sql。
-- 保留旧 models_json 周统计，新字段等客户端上报后填充。
ALTER TABLE players ADD COLUMN models_by_period_json TEXT;
