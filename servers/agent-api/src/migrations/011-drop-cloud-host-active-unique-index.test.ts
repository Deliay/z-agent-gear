import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './011-drop-cloud-host-active-unique-index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 011 drop cloud host active unique index', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('011-drop-cloud-host-active-unique-index');
  });

  it('drops the legacy active unique index', async () => {
    const dropIndex = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ dropIndex } as never);

    await migration.run();

    expect(mongoose.connection.collection).toHaveBeenCalledWith('cloudhosts');
    expect(dropIndex).toHaveBeenCalledWith('uniq_active_cloud_host_per_user');
  });

  it('skips when the index is already absent (IndexNotFound)', async () => {
    const dropIndex = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('index not found'), { code: 27 }));
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ dropIndex } as never);

    await expect(migration.run()).resolves.toBeUndefined();
  });

  it('propagates other failures so the runner retries', async () => {
    const dropIndex = vi.fn().mockRejectedValue(new Error('boom'));
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ dropIndex } as never);

    await expect(migration.run()).rejects.toThrow('boom');
  });
});
