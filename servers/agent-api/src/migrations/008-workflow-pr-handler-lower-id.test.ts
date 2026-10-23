import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './008-workflow-pr-handler-lower-id.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 008 workflow pr handler lower id', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('008-workflow-pr-handler-lower-id');
  });

  it('backfills pullRequestIdLower then creates the index', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 2 });
    const createIndex = vi.fn().mockResolvedValue('ok');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      updateMany,
      createIndex,
    } as never);

    await migration.run();

    expect(mongoose.connection.collection).toHaveBeenCalledWith('workflowprhandlers');
    expect(updateMany).toHaveBeenCalledWith(
      { pullRequestIdLower: { $exists: false } },
      [{ $set: { pullRequestIdLower: { $toLower: '$pullRequestId' } } }],
    );
    expect(createIndex).toHaveBeenCalledWith({ pullRequestIdLower: 1 });
  });

  it('propagates failure so the runner retries on next boot', async () => {
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({
      updateMany: vi.fn().mockResolvedValue({}),
      createIndex: vi.fn().mockRejectedValue(new Error('index build failed')),
    } as never);

    await expect(migration.run()).rejects.toThrow('index build failed');
  });
});
