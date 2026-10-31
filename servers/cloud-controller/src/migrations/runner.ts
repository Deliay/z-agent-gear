import crypto from 'node:crypto';
import { Migrations } from './models.js';

export interface Migration {
  name: string;
  run: () => Promise<void>;
}

/** 本次运行持有的锁归属标识（释放时校验归属）。 */
const LOCK_OWNER = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/** 迁移锁 TTL（5 分钟）：进程崩溃遗留的锁到期后可被后续启动清理并接管。 */
const LOCK_TTL_MS = 300_000;

async function acquireLock(): Promise<boolean> {
  // 清理崩溃遗留的过期锁（此前 expiresAt 从不生效 → 永久锁死未来迁移）。
  // 用 deleteMany 容忍存量库曾出现多条 `_lock` 文档（唯一索引构建失败时可能残留）。
  await Migrations.deleteMany({
    _lock: 'migration_lock',
    expiresAt: { $lt: new Date() },
  }).catch(() => undefined);
  try {
    // `_lock` 唯一索引保证并发双跑只有一个进程能拿到锁。
    await Migrations.create({
      _lock: 'migration_lock',
      owner: LOCK_OWNER,
      acquired: new Date(),
      expiresAt: new Date(Date.now() + LOCK_TTL_MS),
    });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  // 只释放自己持有的锁，避免超时后被他人接管时误删。
  await Migrations.deleteOne({ _lock: 'migration_lock', owner: LOCK_OWNER });
}

/**
 * 迁移 runner（按 admin-api 改进版复刻，账本改用 `cloud_controller_migrations`）：
 * 获取锁 → 读取已执行集合 → 逐个执行未完成的 migration → 释放锁。
 *
 * 单个 migration 失败只记录错误、不写账本、不阻断后续迁移（下次启动按未完成重试），
 * 与 agent-api / admin-api 既有语义一致。
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
