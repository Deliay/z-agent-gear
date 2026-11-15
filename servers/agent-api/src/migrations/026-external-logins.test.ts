import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { EXTERNAL_LOGIN_INDEXES, createExternalLoginIndexes, run } from './026-external-logins.js';

const h = vi.hoisted(() => ({
  collection: {
    indexes: vi.fn(async () => [] as Array<Record<string, unknown>>),
    createIndex: vi.fn(async () => 'idx'),
    dropIndex: vi.fn(async () => undefined),
  },
}));

describe('migration 026-external-logins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.collection.indexes.mockResolvedValue([]);
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue(h.collection as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-MIG26-1: 唯一身份索引 + userId 查询索引规格', () => {
    expect(EXTERNAL_LOGIN_INDEXES).toEqual([
      {
        keys: { providerId: 1, issuer: 1, subject: 1 },
        options: { unique: true, name: 'uniq_external_login_subject' },
      },
      { keys: { userId: 1 }, options: { name: 'external_login_user' } },
    ]);
  });

  it('T-MIG26-2: 幂等创建设计中的两个索引', async () => {
    await createExternalLoginIndexes();
    expect(h.collection.createIndex).toHaveBeenCalledWith(
      { providerId: 1, issuer: 1, subject: 1 },
      { unique: true, name: 'uniq_external_login_subject' },
    );
    expect(h.collection.createIndex).toHaveBeenCalledWith(
      { userId: 1 },
      { name: 'external_login_user' },
    );
  });

  it('T-MIG26-3: 已存在的同名同 spec 索引不重复创建', async () => {
    h.collection.indexes.mockResolvedValue([
      {
        name: 'uniq_external_login_subject',
        key: { providerId: 1, issuer: 1, subject: 1 },
        unique: true,
      },
      { name: 'external_login_user', key: { userId: 1 }, unique: false },
    ]);
    await createExternalLoginIndexes();
    expect(h.collection.createIndex).not.toHaveBeenCalled();
  });

  it('run 记录索引名', async () => {
    h.collection.indexes.mockResolvedValue([{ name: 'uniq_external_login_subject', key: {} }]);
    await run();
    expect(h.collection.createIndex).toHaveBeenCalled();
  });
});
