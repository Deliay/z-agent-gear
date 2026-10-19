import { describe, it, expect, vi, afterEach } from 'vitest';
import { accountService } from '../../services/billing/account-service.js';
import { billingResolvers } from './billing.js';
import type { AdminAuthContext } from './auth.js';

function adminContext(): AdminAuthContext {
  return {
    currentAdmin: { id: 'admin-1', username: 'admin', mustChangePassword: false },
  } as AdminAuthContext;
}

describe('adminBillingAccounts 分页（P1/C4）', () => {
  afterEach(() => vi.restoreAllMocks());

  it('超大 page/pageSize 被钳制到上界，不产生超大 skip', async () => {
    const listSpy = vi.spyOn(accountService, 'list').mockResolvedValue([]);
    const rows = await billingResolvers.Query.adminBillingAccounts(
      null,
      { page: 2 ** 31, pageSize: 2 ** 31 },
      adminContext(),
    );
    expect(rows).toEqual([]);
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ page: 100_000, pageSize: 200 }),
    );
  });

  it('非整数 page 回退默认值', async () => {
    const listSpy = vi.spyOn(accountService, 'list').mockResolvedValue([]);
    await billingResolvers.Query.adminBillingAccounts(
      null,
      { page: Number.NaN, pageSize: 1.5 as unknown as number },
      adminContext(),
    );
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }));
  });
});
