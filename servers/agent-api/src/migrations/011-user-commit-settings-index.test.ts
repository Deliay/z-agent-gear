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
    const indexes = vi.fn().mockResolvedValue([]);
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      createIndex,
      indexes,
    } as never);

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

  it('drops a pre-existing same-key index with a different name (Mongoose autoIndex userId_1)', async () => {
    const createIndex = vi.fn().mockResolvedValue('uniq_user_commit_setting');
    const dropIndex = vi.fn().mockResolvedValue(undefined);
    const indexes = vi.fn().mockResolvedValue([
      { name: '_id_', key: { _id: 1 } },
      { name: 'userId_1', key: { userId: 1 }, unique: true },
    ]);
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      createIndex,
      dropIndex,
      indexes,
    } as never);

    await migration.run();

    expect(dropIndex).toHaveBeenCalledTimes(1);
    expect(dropIndex).toHaveBeenCalledWith('userId_1');
    expect(createIndex).toHaveBeenCalledWith(
      { userId: 1 },
      { unique: true, name: 'uniq_user_commit_setting' },
    );
  });

  it('skips recreation when the named index already matches', async () => {
    const createIndex = vi.fn();
    const dropIndex = vi.fn();
    const indexes = vi.fn().mockResolvedValue([
      { name: '_id_', key: { _id: 1 } },
      { name: 'uniq_user_commit_setting', key: { userId: 1 }, unique: true },
    ]);
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      createIndex,
      dropIndex,
      indexes,
    } as never);

    await migration.run();

    expect(dropIndex).not.toHaveBeenCalled();
    expect(createIndex).not.toHaveBeenCalled();
  });

  it('propagates index creation failure so the runner retries on next boot', async () => {
    const createIndex = vi.fn().mockRejectedValue(new Error('index build failed'));
    const indexes = vi.fn().mockResolvedValue([]);
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      createIndex,
      indexes,
    } as never);

    await expect(migration.run()).rejects.toThrow('index build failed');
  });
});
