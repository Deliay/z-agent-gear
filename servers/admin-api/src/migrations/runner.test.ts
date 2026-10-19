import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./models.js', () => ({
  Migrations: {
    create: vi.fn(),
    find: vi.fn(),
    deleteOne: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

import { Migrations } from './models.js';
import { runMigrations, type Migration } from './runner';

function executedLean(names: string[]) {
  (Migrations.find as any).mockReturnValue({
    lean: vi.fn().mockResolvedValue(names.map((name) => ({ name }))),
  });
}

describe('runMigrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Migrations.create as any).mockResolvedValue({});
    (Migrations.deleteOne as any).mockResolvedValue({ deletedCount: 1 });
    (Migrations.deleteMany as any).mockResolvedValue({ deletedCount: 0 });
  });

  it('skips everything when the lock cannot be acquired', async () => {
    (Migrations.create as any).mockRejectedValue(new Error('E11000 duplicate key'));
    const migration: Migration = { name: '001', run: vi.fn() };

    await runMigrations([migration]);

    expect(migration.run).not.toHaveBeenCalled();
    expect(Migrations.find).not.toHaveBeenCalled();
  });

  it('T-MIG2: skips an already executed migration', async () => {
    executedLean(['001-preset-workloads']);
    const migration: Migration = { name: '001-preset-workloads', run: vi.fn() };

    await runMigrations([migration]);

    expect(migration.run).not.toHaveBeenCalled();
    // 仅锁写入，不写执行记录
    expect(Migrations.create).toHaveBeenCalledTimes(1);
    expect(Migrations.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ _lock: 'migration_lock', owner: expect.any(String) }),
    );
  });

  it('runs a pending migration and records it in admin_migrations', async () => {
    executedLean([]);
    const migration: Migration = { name: '001-preset-workloads', run: vi.fn().mockResolvedValue(undefined) };

    await runMigrations([migration]);

    expect(migration.run).toHaveBeenCalledTimes(1);
    // 🟡7：过期锁清理用 deleteMany（此前 deleteOne 无法清掉多条残留 `_lock` 文档）。
    expect(Migrations.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ _lock: 'migration_lock', expiresAt: expect.any(Object) }),
    );
    expect(Migrations.create).toHaveBeenCalledWith({
      name: '001-preset-workloads',
      executedAt: expect.any(Date),
    });
  });

  it('T-MIG4: a failing migration does not block the rest', async () => {
    executedLean([]);
    const failing: Migration = { name: '001', run: vi.fn().mockRejectedValue(new Error('boom')) };
    const succeeding: Migration = { name: '002', run: vi.fn().mockResolvedValue(undefined) };

    await runMigrations([failing, succeeding]);

    expect(failing.run).toHaveBeenCalledTimes(1);
    expect(succeeding.run).toHaveBeenCalledTimes(1);
    // 失败项不写执行记录，成功项写入
    const recorded = (Migrations.create as any).mock.calls
      .map((call: unknown[]) => call[0] as { name?: string })
      .filter((arg) => arg.name);
    expect(recorded).toEqual([{ name: '002', executedAt: expect.any(Date) }]);
  });

  it('always releases the lock', async () => {    executedLean([]);
    await runMigrations([]);
    expect(Migrations.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ _lock: 'migration_lock', owner: expect.any(String) }),
    );
  });
});
