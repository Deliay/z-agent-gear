import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './006-todo-elicitation-request-id-index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 006 todo elicitation requestId index', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('006-todo-elicitation-request-id-index');
  });

  it('creates the requestId index on todoitems (idempotent by name)', async () => {
    const createIndex = vi.fn().mockResolvedValue('elicitation_request_id');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await migration.run();

    expect(mongoose.connection.collection).toHaveBeenCalledWith('todoitems');
    expect(createIndex).toHaveBeenCalledWith(
      { 'elicitationData.requestId': 1 },
      { name: 'elicitation_request_id' },
    );
  });

  it('propagates index creation failure so the runner retries on next boot', async () => {
    const createIndex = vi.fn().mockRejectedValue(new Error('index build failed'));
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await expect(migration.run()).rejects.toThrow('index build failed');
  });
});
