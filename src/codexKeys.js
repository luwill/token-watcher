/** 兼容已规范化的 Codex 键，避免回退后把同一事件重新入账。 */
export function canonicalCodexKey(key) {
  if (key.startsWith('codex:file:') || key.startsWith('codex:tc:file:')) return key;
  const m = key.match(/^codex:(tc:)?(.+\.jsonl):(.+)$/);
  if (!m) return key;
  const stem = m[2].replaceAll('\\', '/').split('/').pop().slice(0, -6);
  return `codex:${m[1] || ''}file:${stem}:${m[3]}`;
}

const MIGRATION_KEY = 'migration:codex-keys:v1';

/**
 * 旧版按绝对路径去重，新版按文件名去重。一次性原子迁移防止归档/重扫重复入账。
 * 所有改动前的完整行保存在同库 codex_key_migration_backup（不参与统计），
 * 包含旧版留下的额外列。冲突时保留输出更多的完整快照，输出相同则取总量更多；
 * 不把两个快照相加，也不逐字段取最大值。完全相同时优先已规范化的记录。
 */
export function migrateCodexKeys(db) {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // 另一个 CLI/服务可能刚完成迁移；拿到写锁后再确认。
    if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)) {
      let archive;
      const preserve = (table, row) => {
        if (!archive) {
          db.exec(`CREATE TABLE IF NOT EXISTS codex_key_migration_backup (
            table_name TEXT NOT NULL, source_rowid INTEGER NOT NULL, row_json TEXT NOT NULL,
            PRIMARY KEY (table_name, source_rowid)
          )`);
          archive = db.prepare('INSERT OR IGNORE INTO codex_key_migration_backup VALUES (?, ?, ?)');
        }
        const { source_rowid, ...record } = row;
        archive.run(table, source_rowid, JSON.stringify(record));
      };
      // table 是固定内部白名单，不接受外部输入。
      for (const table of ['events', 'tool_calls']) {
        const legacy = db.prepare(`SELECT rowid AS source_rowid, * FROM ${table}
          WHERE tool = 'codex' AND dedup_key NOT LIKE 'codex:file:%'
            AND dedup_key NOT LIKE 'codex:tc:file:%' ORDER BY rowid`).all();
        const find = db.prepare(`SELECT rowid AS source_rowid, * FROM ${table} WHERE dedup_key = ?`);
        const rename = db.prepare(`UPDATE ${table} SET dedup_key = ? WHERE rowid = ?`);
        const remove = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
        for (const row of legacy) {
          const key = canonicalCodexKey(row.dedup_key);
          if (key === row.dedup_key) continue;
          preserve(table, row);
          const existing = find.get(key);
          if (existing) {
            if (existing.tool !== 'codex') throw new Error(`Codex key migration: conflicting tool in ${table}`);
            preserve(table, existing);
            const oldWins = table === 'events' && (row.output_tokens > existing.output_tokens
              || (row.output_tokens === existing.output_tokens && row.total_tokens > existing.total_tokens));
            remove.run(oldWins ? existing.source_rowid : row.source_rowid);
            if (!oldWins) continue;
          }
          rename.run(key, row.source_rowid);
        }
      }
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(MIGRATION_KEY, '1');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
