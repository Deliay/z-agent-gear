import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './007-workflow-pr-handler-index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 007 workflow pr handler index', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('007-workflow-pr-handler-index');
  });

  it('creates query indexes and the unique compound index', async () => {
    const createIndex = vi.fn().mockResolvedValue('ok');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await migration.run();

    expect(mongoose.connection.collection).toHaveBeenCalledWith('workflowprhandlers');
    expect(createIndex).toHaveBeenNthCalledWith(1, { pullRequestId: 1 });
    expect(createIndex).toHaveBeenNthCalledWith(2, { workflowInstanceId: 1 });
    expect(createIndex).toHaveBeenNthCalledWith(3, { workflowInstanceId: 1, nodeId: 1, pullRequestId: 1 }, {
      unique: true,
      name: 'uniq_workflow_pr_handler',
    });
  });

  it('propagates failure so the runner retries on next boot', async () => {
    const createIndex = vi.fn().mockRejectedValue(new Error('E11000 duplicate key'));
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await expect(migration.run()).rejects.toThrow('E11000');
  });
});
