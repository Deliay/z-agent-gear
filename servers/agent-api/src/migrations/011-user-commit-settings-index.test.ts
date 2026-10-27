import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './011-user-commit-settings-index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 011 user commit settings index', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('011-user-commit-settings-index');
  });

  it('creates the unique userId index on user_commit_settings (idempotent by name)', async () => {
    const createIndex = vi.fn().mockResolvedValue('uniq_user_commit_setting');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await migration.run();
    await migration.run();

    expect(mongoose.connection.collection).toHaveBeenCalledWith('user_commit_settings');
    expect(createIndex).toHaveBeenCalledTimes(2);
    expect(createIndex).toHaveBeenNthCalledWith(
      1,
      { userId: 1 },
      { unique: true, name: 'uniq_user_commit_setting' },
    );
  });

  it('propagates index creation failure so the runner retries on next boot', async () => {
    const createIndex = vi.fn().mockRejectedValue(new Error('index build failed'));
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await expect(migration.run()).rejects.toThrow('index build failed');
  });
});
