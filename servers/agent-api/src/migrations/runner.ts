import { logger } from '../observability/logger.js';
import { Migrations } from './models.js';

export interface Migration {
  name: string;
  run: () => Promise<void>;
}

const log = logger.child({ component: 'migration/runner' });

async function acquireLock(): Promise<boolean> {
  try {
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

export async function runMigrations(migrations: Migration[]): Promise<void> {
  const hasLock = await acquireLock();
  if (!hasLock) {
    log.info('migration lock not acquired, skipping');
    return;
  }

  try {
    const executed = await Migrations.find({ name: { $exists: true } }).lean();
    const executedNames = new Set(executed.map((m: Record<string, unknown>) => m.name as string));

    for (const migration of migrations) {
      if (executedNames.has(migration.name)) {
        log.info({ migration: migration.name }, 'already executed, skipping');
        continue;
      }

      log.info({ migration: migration.name }, 'running migration');
      try {
        await migration.run();
        await Migrations.create({ name: migration.name, executedAt: new Date() });
        log.info({ migration: migration.name }, 'migration completed');
      } catch (err) {
        log.error({ err, migration: migration.name }, 'migration failed');
      }
    }
  } finally {
    await releaseLock();
  }
}
