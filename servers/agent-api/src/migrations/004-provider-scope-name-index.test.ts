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

  it('should backfill missing scope, drop legacy name_1 and create the compound unique index', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
    const dropIndex = vi.fn().mockResolvedValue(undefined);
    const createIndex = vi.fn().mockResolvedValue('scope_1_name_1');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ updateMany, dropIndex, createIndex } as never);

    await migration.run();

    expect(updateMany).toHaveBeenCalledWith({ scope: { $exists: false } }, { $set: { scope: 'user' } });
    expect(dropIndex).toHaveBeenCalledWith('name_1');
    expect(createIndex).toHaveBeenCalledWith(
      { scope: 1, name: 1 },
      { unique: true, name: 'scope_1_name_1' },
    );
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
