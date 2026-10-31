import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';

vi.mock('../models/cloud-container.js', () => ({
  CloudContainer: { updateMany: vi.fn() },
}));

import { CloudContainer } from '../models/cloud-container.js';
import * as migration from './001-cloudcontainers-tenant-id-backfill';

let createIndex: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  createIndex = vi.fn().mockResolvedValue('tenantId_1');
  vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);
  (CloudContainer.updateMany as any).mockResolvedValue({ modifiedCount: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 001-cloudcontainers-tenant-id-backfill', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('001-cloudcontainers-tenant-id-backfill');
  });

  it('T-MIG-CC1a: 仅回填 userId 存在且 tenantId 缺失的行，tenantId 复制 userId', async () => {
    (CloudContainer.updateMany as any).mockResolvedValue({ modifiedCount: 3 });

    await migration.run();

    expect(CloudContainer.updateMany).toHaveBeenCalledTimes(1);
    expect(CloudContainer.updateMany).toHaveBeenCalledWith(
      {
        userId: { $exists: true, $nin: [null, ''] },
        $or: [{ tenantId: { $exists: false } }, { tenantId: null }],
      },
      [{ $set: { tenantId: '$userId' } }],
      { updatePipeline: true },
    );
    // userId 只读、不删除：更新阶段仅 $set tenantId
    const update = (CloudContainer.updateMany as any).mock.calls[0][1];
    expect(JSON.stringify(update)).not.toContain('$unset');
  });

  it('T-MIG-CC1b: 显式创建 { tenantId: 1 } 索引', async () => {
    await migration.run();

    expect(mongoose.connection.collection).toHaveBeenCalledWith('cloudcontainers');
    expect(createIndex).toHaveBeenCalledWith({ tenantId: 1 });
  });

  it('T-MIG-CC1c: 幂等重跑（二次 run 零变更、索引调用可重入）', async () => {
    (CloudContainer.updateMany as any)
      .mockResolvedValueOnce({ modifiedCount: 2 })
      .mockResolvedValueOnce({ modifiedCount: 0 });

    await migration.run();
    await migration.run();

    expect(CloudContainer.updateMany).toHaveBeenCalledTimes(2);
    expect(createIndex).toHaveBeenCalledTimes(2);
    expect(createIndex).toHaveBeenNthCalledWith(1, { tenantId: 1 });
    expect(createIndex).toHaveBeenNthCalledWith(2, { tenantId: 1 });
  });

  it('propagates backfill failure so the runner retries on next boot', async () => {
    (CloudContainer.updateMany as any).mockRejectedValue(new Error('mongo down'));

    await expect(migration.run()).rejects.toThrow('mongo down');
    // 回填失败时不再建索引（下次启动整条重试）
    expect(createIndex).not.toHaveBeenCalled();
  });

  it('propagates index failure so the runner retries on next boot', async () => {
    createIndex.mockRejectedValue(new Error('index build failed'));

    await expect(migration.run()).rejects.toThrow('index build failed');
  });
});
