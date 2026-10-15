import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './004-provider-scope-name-index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 004 provider scope name index', () => {
  it('should expose the migration name', () => {
    expect(migration.name).toBe('004-provider-scope-name-index');
  });

  it('should backfill missing scope, create the compound unique index before dropping the legacy name_1 index', async () => {
    const callOrder: string[] = [];
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
    const dropIndex = vi.fn().mockImplementation(() => {
      callOrder.push('drop');
      return Promise.resolve(undefined);
    });
    const createIndex = vi.fn().mockImplementation(() => {
      callOrder.push('create');
      return Promise.resolve('scope_1_name_1');
    });
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ updateMany, dropIndex, createIndex } as never);

    await migration.run();

    expect(updateMany).toHaveBeenCalledWith({ scope: { $exists: false } }, { $set: { scope: 'user' } });
    expect(createIndex).toHaveBeenCalledWith(
      { scope: 1, name: 1 },
      { unique: true, name: 'scope_1_name_1' },
    );
    expect(dropIndex).toHaveBeenCalledWith('name_1');
    // 先建复合唯一索引再删旧索引，避免无唯一约束窗口
    expect(callOrder).toEqual(['create', 'drop']);
  });

  it('should stay idempotent when the legacy index does not exist', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
    const dropIndex = vi.fn().mockRejectedValue(new Error('index not found'));
    const createIndex = vi.fn().mockResolvedValue('scope_1_name_1');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ updateMany, dropIndex, createIndex } as never);

    await expect(migration.run()).resolves.toBeUndefined();
    expect(createIndex).toHaveBeenCalledWith(
      { scope: 1, name: 1 },
      { unique: true, name: 'scope_1_name_1' },
    );
  });
});
