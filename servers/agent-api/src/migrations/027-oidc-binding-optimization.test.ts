import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import {
  USER_PROVIDER_INDEX,
  backfillPasswordless,
  ensureExternalLoginUserProviderIndex,
  run,
} from './027-oidc-binding-optimization.js';

const h = vi.hoisted(() => ({
  externalLogins: {
    indexes: vi.fn(async () => [] as Array<Record<string, unknown>>),
    createIndex: vi.fn(async () => 'idx'),
    dropIndex: vi.fn(async () => undefined),
    distinct: vi.fn(async () => [] as unknown[]),
  },
  accounts: {
    updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
  },
}));

describe('migration 027-oidc-binding-optimization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.externalLogins.indexes.mockResolvedValue([]);
    vi.spyOn(mongoose.connection, 'collection').mockImplementation(((name: string) =>
      name === 'accounts' ? h.accounts : h.externalLogins) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-MIG-OBO1: 每账户每 Provider 唯一索引规格', () => {
    expect(USER_PROVIDER_INDEX).toEqual({
      keys: { userId: 1, providerId: 1 },
      options: { unique: true, name: 'uniq_external_login_user_provider' },
    });
  });

  it('T-MIG-OBO2: 幂等创建唯一索引且已存在同 spec 不重复创建', async () => {
    await ensureExternalLoginUserProviderIndex();
    expect(h.externalLogins.createIndex).toHaveBeenCalledWith(
      { userId: 1, providerId: 1 },
      { unique: true, name: 'uniq_external_login_user_provider' },
    );

    h.externalLogins.createIndex.mockClear();
    h.externalLogins.indexes.mockResolvedValue([
      {
        name: 'uniq_external_login_user_provider',
        key: { userId: 1, providerId: 1 },
        unique: true,
      },
    ]);
    await ensureExternalLoginUserProviderIndex();
    expect(h.externalLogins.createIndex).not.toHaveBeenCalled();
  });

  it('T-MIG-OBO3: 回填仅命中 externallogins 关联账户且未设置字段的文档', async () => {
    h.externalLogins.distinct.mockResolvedValue(['a1', 'a2']);
    h.accounts.updateMany.mockResolvedValue({ modifiedCount: 2 });

    const count = await backfillPasswordless();

    expect(h.externalLogins.distinct).toHaveBeenCalledWith('accountId');
    expect(h.accounts.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ['a1', 'a2'] }, passwordless: { $exists: false } },
      { $set: { passwordless: true } },
    );
    expect(count).toBe(2);
  });

  it('T-MIG-OBO4: 无外部身份账户 / 重复执行无副作用', async () => {
    h.externalLogins.distinct.mockResolvedValue([]);
    await expect(backfillPasswordless()).resolves.toBe(0);
    expect(h.accounts.updateMany).not.toHaveBeenCalled();

    h.externalLogins.distinct.mockResolvedValue(['a1']);
    h.accounts.updateMany.mockResolvedValue({ modifiedCount: 0 });
    await expect(backfillPasswordless()).resolves.toBe(0);
    expect(h.accounts.updateMany).toHaveBeenCalledTimes(1);
  });

  it('run 先建索引后回填并记录结果', async () => {
    h.externalLogins.distinct.mockResolvedValue(['a1']);
    h.accounts.updateMany.mockResolvedValue({ modifiedCount: 1 });
    await run();
    expect(h.externalLogins.createIndex).toHaveBeenCalled();
    expect(h.accounts.updateMany).toHaveBeenCalled();
  });
});
