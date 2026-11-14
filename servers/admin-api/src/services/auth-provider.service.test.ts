import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  model: {
    create: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  },
  encrypt: vi.fn(),
}));

vi.mock('../models/auth-provider.js', () => ({ AuthProvider: h.model }));
vi.mock('./crypto.js', () => ({ encrypt: h.encrypt }));

import { AuthProviderService } from './auth-provider.js';

const service = new AuthProviderService();
const PID = '507f1f77bcf86cd799439011';

function doc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => PID },
    type: 'oidc',
    displayName: 'Corp SSO',
    issuer: 'https://idp.example.com',
    clientId: 'cid',
    scopes: 'openid profile email',
    enabled: false,
    enableFrontLogin: true,
    enableAdminLogin: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function lean(value: unknown) {
  return { lean: async () => value };
}

describe('AuthProviderService 配置域（T-AP）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.encrypt.mockReturnValue({ iv: 'i', ciphertext: 'c', tag: 't' });
  });

  it('T-AP1: 创建 OIDC 加密 secret，出参无 secret 且含 hasSecret/callbackUrl', async () => {
    h.model.create.mockResolvedValue(doc());

    const result = await service.createOidcProvider({
      displayName: ' Corp SSO ',
      issuer: 'https://idp.example.com/',
      clientId: 'cid',
      clientSecret: 'top-secret',
      scopes: 'openid profile email',
    });

    expect(h.encrypt).toHaveBeenCalledWith('top-secret');
    expect(h.model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'oidc',
        displayName: 'Corp SSO',
        issuer: 'https://idp.example.com',
        encryptedClientSecret: { iv: 'i', ciphertext: 'c', tag: 't' },
        enabled: false,
      }),
    );
    expect(JSON.stringify(result)).not.toContain('top-secret');
    expect(result).toMatchObject({ hasSecret: true, callbackUrl: expect.stringContaining('/api/auth/oauth/callback') });
    expect(result).not.toHaveProperty('encryptedClientSecret');
  });

  it('T-AP2: 更新省略 clientSecret = 保持不变', async () => {
    h.model.findOne.mockResolvedValue(doc());
    h.model.findByIdAndUpdate.mockReturnValue(lean(doc({ displayName: 'Renamed' })));

    const result = await service.updateOidcProvider(PID, { displayName: 'Renamed' });
    const update = h.model.findByIdAndUpdate.mock.calls[0][1] as { $set: Record<string, unknown> };
    expect(update.$set).not.toHaveProperty('encryptedClientSecret');
    expect(h.encrypt).not.toHaveBeenCalled();
    expect(result?.displayName).toBe('Renamed');
  });

  it('T-AP3: 更新提供 clientSecret 时重新加密', async () => {
    h.model.findOne.mockResolvedValue(doc());
    h.model.findByIdAndUpdate.mockReturnValue(lean(doc()));
    await service.updateOidcProvider(PID, { clientSecret: 'new-secret' });
    expect(h.encrypt).toHaveBeenCalledWith('new-secret');
  });

  it('T-AP4: GitHub 首次创建要求 clientId+secret，displayName 恒 GitHub', async () => {
    h.model.findOne.mockReturnValue(lean(null));
    h.model.create.mockResolvedValue(doc({ type: 'github_oauth', displayName: 'GitHub', issuer: null }));

    const result = await service.upsertGithubConfig({ clientId: 'cid', clientSecret: 'sec' });
    expect(h.model.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'github_oauth', displayName: 'GitHub', issuer: null, scopes: null }),
    );
    expect(result).toMatchObject({ type: 'github_oauth', callbackUrl: expect.any(String), hasSecret: true });
  });

  it('T-AP5: GitHub 并发创建 E11000 → 回读后按更新处理（单条幂等）', async () => {
    h.model.findOne
      .mockReturnValueOnce(lean(null))
      .mockReturnValueOnce(lean(doc({ type: 'github_oauth', displayName: 'GitHub' })));
    h.model.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    h.model.findByIdAndUpdate.mockReturnValue(lean(doc({ type: 'github_oauth', displayName: 'GitHub' })));

    const result = await service.upsertGithubConfig({ clientId: 'cid', clientSecret: 'sec', enabled: true });
    expect(h.model.findByIdAndUpdate).toHaveBeenCalledWith(
      PID,
      { $set: expect.objectContaining({ enabled: true }) },
      { new: true },
    );
    expect(result.type).toBe('github_oauth');
  });

  it('T-AP6: listForSurface 只返回 enabled + 对应 surface', async () => {
    h.model.find.mockReturnValue({ sort: () => lean([doc(), doc({ _id: { toString: () => 'p2' }, type: 'github_oauth', displayName: 'GitHub' })]) });
    const rows = await service.listForSurface('front');
    expect(h.model.find).toHaveBeenCalledWith({ enabled: true, enableFrontLogin: true });
    expect(rows).toEqual([
      { id: PID, type: 'oidc', displayName: 'Corp SSO' },
      { id: 'p2', type: 'github_oauth', displayName: 'GitHub' },
    ]);
  });

  it('T-AP7: 删除只允许 oidc', async () => {
    h.model.deleteOne.mockResolvedValue({ deletedCount: 1 });
    await expect(service.deleteOidcProvider(PID)).resolves.toBe(true);
    expect(h.model.deleteOne).toHaveBeenCalledWith({ _id: PID, type: 'oidc' });
    await expect(service.deleteOidcProvider('bad-id')).resolves.toBe(false);
  });
});
