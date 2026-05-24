import { Migrations } from './models.js';

export interface Migration {
  name: string;
  run: () => Promise<void>;
}

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
