import { Migrations } from './models.js';

export interface Migration {
  name: string;
  run: () => Promise<void>;
}

async function acquireLock(): Promise<boolean> {
  // D11：清理崩溃遗留的过期锁（此前 expiresAt 从不生效 → 永久锁死未来迁移）。
  await Migrations.deleteOne({
    _lock: 'migration_lock',
    expiresAt: { $lt: new Date() },
  }).catch(() => undefined);
  try {
    // `_lock` 唯一索引保证并发双跑只有一个进程能拿到锁。
    await Migrations.create({
      _lock: 'migration_lock',
      acquired: new Date(),
      expiresAt: new Date(Date.now() + 300_000),
    });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await Migrations.deleteOne({ _lock: 'migration_lock' });
}

/**
 * 迁移 runner（复制 agent-api 口径，账本改用 `admin_migrations`）：
 * 获取锁 → 读取已执行集合 → 逐个执行未完成的 migration → 释放锁。
 * 单个 migration 失败只记录错误、不阻断（下次启动按未完成重试）。
 */
export async function runMigrations(migrations: Migration[]): Promise<void> {
  const hasLock = await acquireLock();
  if (!hasLock) {
    console.log('[Migration] Lock not acquired, skipping');
    return;
  }

  try {
    const executed = await Migrations.find({ name: { $exists: true } }).lean();
    const executedNames = new Set(executed.map((m: Record<string, unknown>) => m.name as string));

    for (const migration of migrations) {
      if (executedNames.has(migration.name)) {
        console.log(`[Migration] ${migration.name} already executed, skipping`);
        continue;
      }

      console.log(`[Migration] Running ${migration.name}...`);
      try {
        await migration.run();
        await Migrations.create({ name: migration.name, executedAt: new Date() });
        console.log(`[Migration] ${migration.name} completed`);
      } catch (err) {
        console.error(`[Migration] ${migration.name} failed:`, err);
      }
    }
  } finally {
    await releaseLock();
  }
}
