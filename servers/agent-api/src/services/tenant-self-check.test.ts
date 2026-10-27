import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  user: { find: vi.fn(), countDocuments: vi.fn() },
  tenant: { countDocuments: vi.fn() },
  collections: new Map<string, { countDocuments: ReturnType<typeof vi.fn> }>(),
}));

vi.mock('../models/user.js', () => ({ User: h.user }));
vi.mock('../models/tenant.js', () => ({ Tenant: h.tenant }));

import mongoose from 'mongoose';
import { runTenantSelfCheck, scheduleTenantSelfCheck } from './tenant-self-check.js';

function sampleQuery(rows: unknown[]) {
  return { select: () => ({ limit: () => ({ lean: async () => rows }) }) };
}

describe('tenant self check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.collections.clear();
    vi.spyOn(mongoose.connection, 'collection').mockImplementation(((name: string) => {
      const fake = { countDocuments: vi.fn().mockResolvedValue(0) };
      h.collections.set(name, fake);
      return fake;
    }) as never);

    h.user.countDocuments.mockResolvedValue(0);
    h.user.find.mockReturnValue(sampleQuery([{ _id: 'u1', name: 'a', tenantId: 'u1' }]));
    h.tenant.countDocuments.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses indexed counts + limited sampling and reports no warnings on healthy data', async () => {
    const result = await runTenantSelfCheck();

    expect(result.warnings).toEqual([]);
    expect(result.sampled).toBe(1);
    expect(h.user.countDocuments).toHaveBeenCalledTimes(2);
    expect(h.user.find).toHaveBeenCalledWith({});
    // 19 collections counted, each with a tenantId-missing filter
    expect(h.collections.size).toBe(19);
    for (const fake of h.collections.values()) {
      expect(fake.countDocuments).toHaveBeenCalledWith({ tenantId: { $exists: false } });
    }
  });

  it('warns (without throwing) on inconsistent data', async () => {
    h.user.countDocuments.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    h.user.find.mockReturnValue(sampleQuery([{ _id: 'u1', tenantId: 'other' }]));
    h.tenant.countDocuments.mockResolvedValue(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runTenantSelfCheck();

    expect(result.warnings.join('\n')).toContain('users without account: 2');
    expect(result.warnings.join('\n')).toContain('users without tenantId: 3');
    expect(result.warnings.join('\n')).toContain('sampled users with tenantId != userId: 1');
    expect(result.warnings.join('\n')).toContain('sampled users without name: 1');
    expect(warn).toHaveBeenCalled();
  });

  it('swallows failures and returns a warning instead of throwing', async () => {
    h.user.countDocuments.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runTenantSelfCheck();

    expect(result.warnings[0]).toContain('self-check failed');
    expect(warn).toHaveBeenCalled();
  });

  it('schedules asynchronously without throwing', async () => {
    const immediate = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((fn: () => void) => {
      fn();
      return 1 as never;
    }) as never);
    h.user.countDocuments.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => scheduleTenantSelfCheck()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(immediate).toHaveBeenCalled();
  });
});
