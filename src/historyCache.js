/**
 * "今天 0 点之前"的全历史聚合缓存（issue #13）。
 *
 * 面板每次推送都重取 summary，其中全历史按本地日分组、全时段费用分组两条查询
 * 每次都扫一遍全部 events：百万行时一次 6.5s，Agent 活跃时约每秒一次。
 * 历史几乎不再变化，于是把 ts < boundary（本地今天 0 点）的聚合结果缓存下来，
 * 调用方只再聚合 ts >= boundary 的部分合并即可。
 *
 * 失效（任一成立即整体重建）：
 * - 本连接改了历史行：TEMP 触发器在 events 上 ts < boundary 的插入 / 更新 / 删除时置 dirty。
 *   覆盖所有写入路径（去重补登、模型回填、Codex 整文件重建……），不必逐个写入方法打点；
 *   随写入所在事务一起回滚。TEMP 对象只存在于本连接，不改库表结构。
 * - 其他连接提交过写入（serve 运行时另开 `token-watcher scan`）：PRAGMA data_version 变化。
 * - 跨过零点：boundary 变化。
 *
 * 缓存的是 SQL 分组行而不是算好的金额：单价、汇率每次现算，改 pricing.json 即时生效。
 *
 * 不变式：事务进行中不读也不写缓存。dirty 标记随事务回滚，JS 里的 entries 不会；
 * 若在事务里重建缓存而事务随后回滚，缓存会停在已撤销的数据上且无从失效。
 * 因此事务中一律现算（结果对当前事务可见的数据正确），不碰缓存与 guard 表。
 */

const caches = new WeakMap(); // DatabaseSync → { boundary, version, entries }

/** 本连接是否处于事务中。db.isTransaction 自 Node 22.16 起才有，更早版本用 BEGIN 试探 */
function inTransaction(db) {
  if (typeof db.isTransaction === 'boolean') return db.isTransaction;
  try {
    db.exec('BEGIN');
  } catch {
    return true; // cannot start a transaction within a transaction
  }
  db.exec('COMMIT');
  return false;
}

function install(db) {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS tw_history_guard (boundary INTEGER NOT NULL, dirty INTEGER NOT NULL);
    CREATE TEMP TRIGGER IF NOT EXISTS tw_history_ins AFTER INSERT ON main.events
      WHEN NEW.ts < (SELECT boundary FROM temp.tw_history_guard)
      BEGIN UPDATE tw_history_guard SET dirty = 1; END;
    CREATE TEMP TRIGGER IF NOT EXISTS tw_history_upd AFTER UPDATE ON main.events
      WHEN OLD.ts < (SELECT boundary FROM temp.tw_history_guard)
        OR NEW.ts < (SELECT boundary FROM temp.tw_history_guard)
      BEGIN UPDATE tw_history_guard SET dirty = 1; END;
    CREATE TEMP TRIGGER IF NOT EXISTS tw_history_del AFTER DELETE ON main.events
      WHEN OLD.ts < (SELECT boundary FROM temp.tw_history_guard)
      BEGIN UPDATE tw_history_guard SET dirty = 1; END;`);
}

/**
 * 取 key 对应的历史聚合；缓存失效时整体清空，按需调用 compute(boundary) 重算。
 * compute 只能读 ts < boundary 的行。
 */
export function cachedHistory(db, key, boundary, compute) {
  if (inTransaction(db)) return compute(boundary);
  let c = caches.get(db);
  if (!c) {
    install(db);
    c = { boundary: null, version: null, entries: new Map() };
    caches.set(db, c);
  }
  const version = db.prepare('PRAGMA data_version').get().data_version;
  const dirty = db.prepare('SELECT dirty FROM temp.tw_history_guard').get()?.dirty;
  if (c.boundary !== boundary || c.version !== version || dirty !== 0) {
    // 先布防再重算：同步执行，期间本连接不会有别的写入插进来
    db.exec('DELETE FROM temp.tw_history_guard');
    db.prepare('INSERT INTO temp.tw_history_guard (boundary, dirty) VALUES (?, 0)').run(boundary);
    c.boundary = boundary;
    c.version = version;
    c.entries.clear();
  }
  if (!c.entries.has(key)) c.entries.set(key, compute(boundary));
  return c.entries.get(key);
}
