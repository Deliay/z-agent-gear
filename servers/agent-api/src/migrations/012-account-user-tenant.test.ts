import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  user: {
    find: vi.fn(),
    updateOne: vi.fn(),
    countDocuments: vi.fn(),
  },
  account: {
    findOne: vi.fn(),
    create: vi.fn(),
  },
  tenant: {
    findById: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../models/user.js', () => ({ User: h.user }));
vi.mock('../models/account.js', () => ({ Account: h.account }));
vi.mock('../models/tenant.js', () => ({ Tenant: h.tenant }));

import * as migration from './012-account-user-tenant.js';

const USER_ID = '507f1f77bcf86cd799439011';

function leanQuery(rows: unknown[]) {
  return {
    sort: () => ({
      limit: () => ({
        lean: async () => rows,
      }),
    }),
  };
}

describe('migration 012 account/user/tenant', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.user.updateOne.mockResolvedValue({ modifiedCount: 1 });
    h.user.countDocuments.mockResolvedValue(0);
    h.tenant.findById.mockReturnValue({ lean: async () => null });
    h.tenant.create.mockResolvedValue({});
    h.account.findOne.mockReturnValue({ lean: async () => null });
    h.account.create.mockResolvedValue({
      _id: 'acc-1',
      username: 'alice',
      passwordHash: 'hash',
    });
  });

  it('splits a legacy user into account + user fields + personal tenant (keeps login fields)', async () => {
    h.user.find.mockReturnValue(leanQuery([{ _id: USER_ID, username: 'alice', passwordHash: 'hash' }]));

    await migration.run();

    expect(h.account.create).toHaveBeenCalledWith({ username: 'alice', passwordHash: 'hash' });
    const patch = h.user.updateOne.mock.calls[0][1].$set;
    expect(patch).toEqual({ name: 'alice', tenantId: USER_ID, accountId: 'acc-1' });
    expect(patch).not.toHaveProperty('$unset');
    expect(h.tenant.create).toHaveBeenCalledWith({
      _id: USER_ID,
      name: 'alice',
      type: 'personal',
    });
  });

  it('is idempotent: fully migrated user causes no creates/updates', async () => {
    h.user.find.mockReturnValue(
      leanQuery([
        {
          _id: USER_ID,
          username: 'alice',
          passwordHash: 'hash',
          name: 'alice',
          tenantId: USER_ID,
          accountId: 'acc-1',
        },
      ]),
    );
    h.tenant.findById.mockReturnValue({ lean: async () => ({ _id: USER_ID }) });

    await migration.run();

    expect(h.account.create).not.toHaveBeenCalled();
    expect(h.user.updateOne).not.toHaveBeenCalled();
    expect(h.tenant.create).not.toHaveBeenCalled();
  });

  it('fills half-completed state (missing tenant and user fields)', async () => {
    h.user.find.mockReturnValue(
      leanQuery([{ _id: USER_ID, username: 'alice', passwordHash: 'hash', accountId: 'acc-1' }]),
    );

    await migration.run();

    expect(h.user.updateOne).toHaveBeenCalledWith(
      { _id: USER_ID },
      { $set: { name: 'alice', tenantId: USER_ID } },
    );
    expect(h.tenant.create).toHaveBeenCalled();
  });

  it('pages through multiple batches', async () => {
    const first = Array.from({ length: migration.BATCH_SIZE }, (_, i) => ({
      _id: `id-${i}`,
      username: `u${i}`,
      passwordHash: 'h',
    }));
    h.user.find
      .mockReturnValueOnce(leanQuery(first))
      .mockReturnValueOnce(leanQuery([{ _id: 'last', username: 'last', passwordHash: 'h' }]));
    h.account.create.mockImplementation(async ({ username }: { username: string }) => ({
      _id: `acc-${username}`,
      username,
      passwordHash: 'h',
    }));

    await migration.run();

    expect(h.user.find).toHaveBeenCalledTimes(2);
    expect(h.account.create).toHaveBeenCalledTimes(migration.BATCH_SIZE + 1);
  });
});
