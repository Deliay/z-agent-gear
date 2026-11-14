import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  externalLogin: {
    findOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn(),
  },
  user: { findById: vi.fn() },
  account: { findById: vi.fn() },
  provision: vi.fn(),
  rollback: vi.fn(),
  hashPassword: vi.fn(async () => 'hash'),
  redis: {
    set: vi.fn(async () => 'OK'),
    eval: vi.fn(async () => 1),
  },
}));

vi.mock('../models/external-login.js', () => ({ ExternalLogin: h.externalLogin }));
vi.mock('../models/user.js', () => ({ User: h.user }));
vi.mock('../models/account.js', () => ({ Account: h.account }));
vi.mock('./provisioning.js', () => ({
  provisionUser: h.provision,
  ProvisioningError: class ProvisioningError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock('./auth.js', () => ({ hashPassword: h.hashPassword }));
vi.mock('../middleware/redis.js', () => ({ getRedisClient: () => h.redis }));

import { deriveUsername, resolveExternalLogin } from './external-login.js';

const IDENTITY = {
  providerId: '507f1f77bcf86cd799439011',
  issuer: 'http://idp',
  subject: 'sub-1',
  externalUsername: 'octo.test',
  displayName: 'Octo',
};

function q(value: unknown) {
  return { lean: async () => value };
}

function provisioned(username = 'octotest') {
  return {
    user: { id: 'u1', name: username, createdAt: '2026-01-01T00:00:00.000Z' },
    account: { id: 'a1', username },
    created: true,
    rollback: h.rollback,
  };
}

describe('deriveUsername', () => {
  it('保留 [a-zA-Z0-9_-]', () => {
    expect(deriveUsername('octo-test_1')).toBe('octo-test_1');
  });

  it('过滤非法字符并截断 20', () => {
    expect(deriveUsername('john.doe@example.com')).toBe('johndoeexamplecom');
    expect(deriveUsername('x'.repeat(40))).toHaveLength(20);
  });

  it('不足 2 字符时补 u_ 前缀', () => {
    expect(deriveUsername('a')).toBe('u_a');
    expect(deriveUsername('!!!').length).toBeGreaterThanOrEqual(2);
  });
});

describe('resolveExternalLogin（T-EXT）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.redis.set.mockResolvedValue('OK');
    h.user.findById.mockReturnValue(q({
      _id: 'u1',
      name: 'Octo',
      tenantId: 'u1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    h.account.findById.mockReturnValue(q({ _id: 'a1', username: 'octotest' }));
    h.externalLogin.updateOne.mockResolvedValue({});
    h.externalLogin.create.mockResolvedValue({});
    h.provision.mockResolvedValue(provisioned());
  });

  it('T-EXT1: 已有绑定 → 更新 lastLoginAt 并返回同一账户（不开户）', async () => {
    h.externalLogin.findOne.mockReturnValue(q({ _id: 'el1', userId: 'u1', accountId: 'a1' }));
    const result = await resolveExternalLogin(IDENTITY);
    expect(h.externalLogin.updateOne).toHaveBeenCalledWith(
      { _id: 'el1' },
      expect.objectContaining({ $set: expect.objectContaining({ lastLoginAt: expect.any(Date) }) }),
    );
    expect(h.provision).not.toHaveBeenCalled();
    expect(result.user.id).toBe('u1');
    expect(result.created).toBe(false);
  });

  it('T-EXT2: 首次登录 → 派生用户名开户并落 externallogins', async () => {
    h.externalLogin.findOne.mockReturnValue(q(null));
    const result = await resolveExternalLogin(IDENTITY);
    expect(h.provision).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'octotest', source: 'oauth' }),
    );
    expect(h.externalLogin.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        tenantId: 'u1',
        accountId: 'a1',
        subject: 'sub-1',
      }),
    );
    expect(result.created).toBe(true);
  });

  it('T-EXT3: 用户名冲突 → 追加随机后缀重试至多 5 次', async () => {
    h.externalLogin.findOne.mockReturnValue(q(null));
    const ProvisioningError = await import('./provisioning.js').then((m) => m.ProvisioningError);
    h.provision
      .mockRejectedValueOnce(new ProvisioningError('USERNAME_TAKEN'))
      .mockResolvedValueOnce(provisioned('octotest-ab12'));

    await resolveExternalLogin(IDENTITY);
    expect(h.provision).toHaveBeenCalledTimes(2);
    expect((h.provision.mock.calls[1][0] as { username: string }).username).toMatch(/^octotest-[0-9a-f]{4}$/);
  });

  it('T-EXT4: 并发唯一冲突 → 回滚本次开户并回读胜方（无孤儿账户）', async () => {
    h.externalLogin.findOne
      .mockReturnValueOnce(q(null))
      .mockReturnValueOnce(q({ _id: 'el2', userId: 'u-win', accountId: 'a-win' }));
    h.externalLogin.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    h.user.findById.mockReturnValue(q({
      _id: 'u-win',
      name: 'Winner',
      tenantId: 'u-win',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    }));

    const result = await resolveExternalLogin(IDENTITY);
    expect(h.rollback).toHaveBeenCalledTimes(1);
    expect(result.user.id).toBe('u-win');
    expect(result.created).toBe(false);
  });

  it('T-EXT5: 绑定写入非唯一异常 → 回滚本次开户并抛错', async () => {
    h.externalLogin.findOne.mockReturnValue(q(null));
    h.externalLogin.create.mockRejectedValue(new Error('write failed'));

    await expect(resolveExternalLogin(IDENTITY)).rejects.toThrow('write failed');
    expect(h.rollback).toHaveBeenCalledTimes(1);
  });

  it('T-EXT6: 计费失败 → 向调用方抛出（路由映射 provision_failed）', async () => {
    h.externalLogin.findOne.mockReturnValue(q(null));
    const ProvisioningError = await import('./provisioning.js').then((m) => m.ProvisioningError);
    h.provision.mockRejectedValue(new ProvisioningError('BILLING_UNAVAILABLE'));

    await expect(resolveExternalLogin(IDENTITY)).rejects.toMatchObject({
      code: 'BILLING_UNAVAILABLE',
    });
  });

  it('T-EXT7: 身份锁使用 SET NX PX 并在结束后释放', async () => {
    h.externalLogin.findOne.mockReturnValue(q({ _id: 'el1', userId: 'u1', accountId: 'a1' }));
    await resolveExternalLogin(IDENTITY);
    expect(h.redis.set).toHaveBeenCalledWith(
      expect.stringContaining('oauth:identity-lock:'),
      expect.any(String),
      'PX',
      10000,
      'NX',
    );
    expect(h.redis.eval).toHaveBeenCalled();
  });

  it('T-EXT8: 用户名冲突超过 5 次 → USERNAME_TAKEN', async () => {
    h.externalLogin.findOne.mockReturnValue(q(null));
    const ProvisioningError = await import('./provisioning.js').then((m) => m.ProvisioningError);
    h.provision.mockRejectedValue(new ProvisioningError('USERNAME_TAKEN'));

    await expect(resolveExternalLogin(IDENTITY)).rejects.toMatchObject({
      code: 'USERNAME_TAKEN',
    });
    expect(h.provision).toHaveBeenCalledTimes(5);
  });
});
