import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/billing-api-key.js', () => ({
  BillingApiKey: { updateMany: vi.fn() },
}));

import { BillingApiKey } from '../models/billing-api-key.js';
import * as migration from './010-clear-cloud-host-key-expiry';

describe('migration 010-clear-cloud-host-key-expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (BillingApiKey.updateMany as any).mockResolvedValue({ modifiedCount: 0 });
  });

  it('exposes the migration name', () => {
    expect(migration.name).toBe('010-clear-cloud-host-key-expiry');
  });

  it('T-MIG10a-1: 仅清空 active 云电脑 Key 的 expiresAt', async () => {
    (BillingApiKey.updateMany as any).mockResolvedValue({ modifiedCount: 2 });

    await migration.run();

    expect(BillingApiKey.updateMany).toHaveBeenCalledTimes(1);
    expect(BillingApiKey.updateMany).toHaveBeenCalledWith(
      { scope: 'cloud_host', status: 'active', expiresAt: { $ne: null } },
      { $set: { expiresAt: null } },
    );
  });

  it('T-MIG10a-2: 无匹配记录时幂等（不抛错、不重复写入）', async () => {
    await migration.run();
    await migration.run();

    expect(BillingApiKey.updateMany).toHaveBeenCalledTimes(2);
    expect(BillingApiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'cloud_host', status: 'active' }),
      { $set: { expiresAt: null } },
    );
  });
});
