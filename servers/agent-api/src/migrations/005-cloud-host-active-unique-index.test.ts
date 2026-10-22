import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './005-cloud-host-active-unique-index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 005 cloud host active unique index', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('005-cloud-host-active-unique-index');
  });

  it('creates the partial unique index with the active-status filter', async () => {
    const createIndex = vi.fn().mockResolvedValue('uniq_active_cloud_host_per_user');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await migration.run();

    expect(mongoose.connection.collection).toHaveBeenCalledWith('cloudhosts');
    expect(createIndex).toHaveBeenCalledWith(
      { userId: 1 },
      {
        unique: true,
        name: 'uniq_active_cloud_host_per_user',
        partialFilterExpression: {
          status: { $in: ['STARTING', 'RUNNING', 'STOPPING'] },
          deletedAt: null,
        },
      },
    );
  });

  it('propagates duplicate-data failure so the runner retries on next boot', async () => {
    const createIndex = vi.fn().mockRejectedValue(new Error('E11000 duplicate key'));
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await expect(migration.run()).rejects.toThrow('E11000');
  });
});
