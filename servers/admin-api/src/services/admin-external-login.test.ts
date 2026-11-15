import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  model: {
    findOneAndUpdate: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    find: vi.fn(),
    deleteOne: vi.fn(),
    updateOne: vi.fn(),
  },
  provider: { findById: vi.fn() },
}));

vi.mock('../models/admin-external-login.js', () => ({ AdminExternalLogin: h.model }));
vi.mock('../models/auth-provider.js', () => ({ AuthProvider: h.provider }));
vi.mock('./auth-provider.js', () => ({ GITHUB_OAUTH_DISPLAY_NAME: 'GitHub' }));

import { adminExternalLoginService } from './admin-external-login.js';

const ADMIN_ID = '507f1f77bcf86cd799439011';
const PROVIDER_ID = '507f1f77bcf86cd799439012';

function lean(value: unknown) {
  return { lean: async () => value };
}

function chainLean(value: unknown) {
  return { lean: async () => value };
}

const IDENTITY = {
  providerId: PROVIDER_ID,
  issuer: 'http://idp',
  subject: 'sub-1',
  externalUsername: 'octo',
  displayName: 'Octo',
};

describe('admin-external-login（T-AEL）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.provider.findById.mockReturnValue({
      select: () => chainLean({ type: 'github_oauth', displayName: 'GitHub' }),
    });
  });

  it('T-AEL1: bind upsert 幂等', async () => {
    h.model.findOneAndUpdate.mockReturnValue(lean({ _id: 'b1', adminUserId: ADMIN_ID }));
    const doc = await adminExternalLoginService.bind(ADMIN_ID, IDENTITY);
    expect(h.model.findOneAndUpdate).toHaveBeenCalledWith(
      { adminUserId: ADMIN_ID, providerId: PROVIDER_ID },
      expect.objectContaining({ $set: expect.objectContaining({ subject: 'sub-1' }) }),
      expect.objectContaining({ upsert: true, new: true }),
    );
    expect(doc).toMatchObject({ _id: 'b1' });
  });

  it('T-AEL2: 非法 id 直接抛错（无写入）', async () => {
    await expect(adminExternalLoginService.bind('bad', IDENTITY)).rejects.toThrow('INVALID_ID');
    expect(h.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('T-AEL3: 唯一冲突且身份已绑其他管理员 → EXTERNAL_IDENTITY_ALREADY_BOUND', async () => {
    h.model.findOneAndUpdate.mockReturnValue({
      lean: async () => {
        throw Object.assign(new Error('dup'), { code: 11000 });
      },
    });
    h.model.findOne.mockReturnValue(
      lean({ _id: 'b1', adminUserId: 'other-admin', providerId: PROVIDER_ID }),
    );
    await expect(adminExternalLoginService.bind(ADMIN_ID, IDENTITY)).rejects.toThrow(
      'EXTERNAL_IDENTITY_ALREADY_BOUND',
    );
  });

  it('T-AEL4: 并发 upsert 冲突且本人行已存在 → 回读更新', async () => {
    h.model.findOneAndUpdate.mockReturnValue({
      lean: async () => {
        throw Object.assign(new Error('dup'), { code: 11000 });
      },
    });
    h.model.findOne.mockReturnValue(lean({ _id: 'b1', adminUserId: ADMIN_ID }));
    h.model.findByIdAndUpdate.mockReturnValue(lean({ _id: 'b1', subject: 'sub-1' }));
    const doc = await adminExternalLoginService.bind(ADMIN_ID, IDENTITY);
    expect(doc).toMatchObject({ _id: 'b1' });
  });

  it('T-AEL5: listByAdmin 带 provider 展示名', async () => {
    h.model.find.mockReturnValue({
      sort: () => lean([{ _id: 'b1', providerId: PROVIDER_ID, externalUsername: 'octo', createdAt: new Date('2026-01-01') }]),
    });
    const rows = await adminExternalLoginService.listByAdmin(ADMIN_ID);
    expect(rows[0]).toMatchObject({
      id: 'b1',
      providerDisplayName: 'GitHub',
      externalUsername: 'octo',
    });
  });

  it('T-AEL6: findBound 命中更新 lastLoginAt；unbind 仅本人', async () => {
    h.model.findOne.mockResolvedValue({ _id: 'b1', adminUserId: ADMIN_ID });
    h.model.updateOne.mockResolvedValue({});
    const bound = await adminExternalLoginService.findBound(IDENTITY);
    expect(bound?._id).toBe('b1');
    expect(h.model.updateOne).toHaveBeenCalledWith(
      { _id: 'b1' },
      { $set: { lastLoginAt: expect.any(Date) } },
    );

    h.model.deleteOne.mockResolvedValue({ deletedCount: 1 });
    await expect(adminExternalLoginService.unbind(ADMIN_ID, 'b1')).resolves.toBe(false);
    await expect(adminExternalLoginService.unbind(ADMIN_ID, PROVIDER_ID)).resolves.toBe(true);
    expect(h.model.deleteOne).toHaveBeenCalledWith({ _id: PROVIDER_ID, adminUserId: ADMIN_ID });
  });
});
