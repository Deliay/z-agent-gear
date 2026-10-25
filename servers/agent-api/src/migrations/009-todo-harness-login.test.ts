import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './009-todo-harness-login.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 009 todo harness login requestId index', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('009-todo-harness-login');
  });

  it('creates the harnessLoginData.requestId index on todoitems (idempotent by name)', async () => {
    const createIndex = vi.fn().mockResolvedValue('harness_login_request_id');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await migration.run();

    expect(mongoose.connection.collection).toHaveBeenCalledWith('todoitems');
    expect(createIndex).toHaveBeenCalledWith(
      { 'harnessLoginData.requestId': 1 },
      { name: 'harness_login_request_id' },
    );
  });

  it('is idempotent on a second run (same index name reused)', async () => {
    const createIndex = vi.fn().mockResolvedValue('harness_login_request_id');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await migration.run();
    await migration.run();

    expect(createIndex).toHaveBeenCalledTimes(2);
    expect(createIndex.mock.calls[0]).toEqual(createIndex.mock.calls[1]);
  });

  it('propagates index creation failure so the runner retries on next boot', async () => {
    const createIndex = vi.fn().mockRejectedValue(new Error('index build failed'));
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await expect(migration.run()).rejects.toThrow('index build failed');
  });
});
