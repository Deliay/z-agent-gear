import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  account: { findOne: vi.fn(), create: vi.fn(), deleteOne: vi.fn() },
  user: { findOne: vi.fn(), create: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() },
  tenant: { findById: vi.fn(), create: vi.fn(), deleteOne: vi.fn() },
  billing: { getAccount: vi.fn() },
  workspace: { ensureGlobalWorkspace: vi.fn() },
}));

vi.mock('../models/account.js', () => ({ Account: h.account }));
vi.mock('../models/user.js', () => ({ User: h.user }));
vi.mock('../models/tenant.js', () => ({ Tenant: h.tenant }));
vi.mock('./billing-client.js', () => ({ billingClient: h.billing }));
vi.mock('./workspace-service.js', () => ({ workspaceService: h.workspace }));

import { provisionUser, ProvisioningError } from './provisioning.js';

describe('provisionUser（T-PROV）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.account.deleteOne.mockResolvedValue({});
    h.user.deleteOne.mockResolvedValue({});
    h.tenant.deleteOne.mockResolvedValue({});
    h.billing.getAccount.mockResolvedValue({ id: 'b1' });
    h.workspace.ensureGlobalWorkspace.mockResolvedValue({ id: 'ws1', name: '全局工作区', type: 'global' });
  });

  it('创建账户+用户+租户+计费账户+全局工作区，返回 rollback', async () => {
    h.account.findOne.mockResolvedValue(null);
    h.account.create.mockResolvedValue({ _id: 'acc1', username: 'alice', passwordHash: 'h' });
    h.user.findOne.mockResolvedValue(null);
    h.user.create.mockImplementation(async (doc: Record<string, unknown>) => ({
      ...doc,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    h.tenant.findById.mockResolvedValue(null);
    h.tenant.create.mockImplementation(async (doc: Record<string, unknown>) => doc);

    const result = await provisionUser({ username: 'alice', passwordHash: 'h', source: 'internal' });

    expect(result.created).toBe(true);
    expect(result.account).toEqual({ id: 'acc1', username: 'alice' });
    expect(h.billing.getAccount).toHaveBeenCalledWith('tenant', expect.any(String), 'alice');
    expect(h.workspace.ensureGlobalWorkspace).toHaveBeenCalled();
    expect(typeof result.rollback).toBe('function');

    await result.rollback();
    expect(h.account.deleteOne).toHaveBeenCalled();
    expect(h.user.deleteOne).toHaveBeenCalled();
    expect(h.tenant.deleteOne).toHaveBeenCalled();
  });

  it('source=oauth 且用户名已存在 → USERNAME_TAKEN（不复用既有账户）', async () => {
    h.account.findOne.mockResolvedValue({ _id: 'acc1', username: 'alice', passwordHash: 'h' });
    await expect(
      provisionUser({ username: 'alice', passwordHash: 'h', source: 'oauth' }),
    ).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    expect(h.billing.getAccount).not.toHaveBeenCalled();
  });

  it('计费不可达 → 回滚并抛 BILLING_UNAVAILABLE', async () => {
    h.account.findOne.mockResolvedValue(null);
    h.account.create.mockResolvedValue({ _id: 'acc1', username: 'alice', passwordHash: 'h' });
    h.user.findOne.mockResolvedValue(null);
    h.user.create.mockImplementation(async (doc: Record<string, unknown>) => doc);
    h.tenant.findById.mockResolvedValue(null);
    h.tenant.create.mockImplementation(async (doc: Record<string, unknown>) => doc);
    h.billing.getAccount.mockRejectedValue(new Error('billing down'));

    await expect(
      provisionUser({ username: 'alice', passwordHash: 'h', source: 'internal' }),
    ).rejects.toBeInstanceOf(ProvisioningError);
    expect(h.account.deleteOne).toHaveBeenCalled();
    expect(h.user.deleteOne).toHaveBeenCalled();
    expect(h.tenant.deleteOne).toHaveBeenCalled();
  });

  it('existingAccount=null 跳过首次查询，直接创建（端点已查询）', async () => {
    h.account.create.mockResolvedValue({ _id: 'acc1', username: 'bob', passwordHash: 'h' });
    h.user.findOne.mockResolvedValue(null);
    h.user.create.mockImplementation(async (doc: Record<string, unknown>) => doc);
    h.tenant.findById.mockResolvedValue(null);
    h.tenant.create.mockImplementation(async (doc: Record<string, unknown>) => doc);

    await provisionUser({
      username: 'bob',
      passwordHash: 'h',
      source: 'internal',
      existingAccount: null,
    });
    expect(h.account.findOne).not.toHaveBeenCalled();
  });
});
