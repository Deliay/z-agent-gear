import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  externalLogin: {
    findOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn(),
    countDocuments: vi.fn(),
    deleteOne: vi.fn(),
    find: vi.fn(),
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

import {
  bindExternalLoginToUser,
  deriveUsername,
  ExternalLoginError,
  findExternalLogin,
  listExternalLogins,
  provisionExternalLogin,
  unbindExternalLogin,
} from './external-login.js';

const IDENTITY = {
  providerId: '507f1f77bcf86cd799439011',
  issuer: 'http://idp',
  subject: 'sub-1',
  externalUsername: 'octo.test',
  displayName: 'Octo',
};
const USER = {
  id: '507f1f77bcf86cd799439012',
  accountId: '507f1f77bcf86cd799439013',
  tenantId: '507f1f77bcf86cd799439014',
};

function q(value: unknown) {
  return { lean: async () => value };
}

function sortedQ(value: unknown) {
  return { sort: () => ({ lean: async () => value }) };
}

function provisioned(username = 'octotest') {
  return {
    user: { id: 'u1', name: username, createdAt: '2026-01-01T00:00:00.000Z' },
    account: { id: 'a1', username },
    created: true,
    rollback: h.rollback,
  };
}

function bindingDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'el1',
    userId: USER.id,
    tenantId: USER.tenantId,
    accountId: USER.accountId,
    providerId: IDENTITY.providerId,
    issuer: IDENTITY.issuer,
    subject: IDENTITY.subject,
    externalUsername: IDENTITY.externalUsername,
    displayName: IDENTITY.displayName,
    avatarUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
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

describe('external-login 四入口（T-EXT-B）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.redis.set.mockResolvedValue('OK');
    h.user.findById.mockReturnValue(
      q({
        _id: 'u1',
        name: 'Octo',
        tenantId: 'u1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
    h.account.findById.mockReturnValue(q({ _id: 'a1', username: 'octotest' }));
    h.externalLogin.updateOne.mockResolvedValue({});
    h.externalLogin.create.mockResolvedValue({ toObject: () => bindingDoc() });
    h.externalLogin.deleteOne.mockResolvedValue({ deletedCount: 1 });
    h.externalLogin.countDocuments.mockResolvedValue(2);
    h.provision.mockResolvedValue(provisioned());
  });

  it('T-EXT-B1: find 命中更新 lastLoginAt 快照并返回同一账户', async () => {
    h.externalLogin.findOne.mockReturnValue(q({ _id: 'el1', userId: 'u1', accountId: 'a1' }));
    const result = await findExternalLogin(IDENTITY);
    expect(h.externalLogin.updateOne).toHaveBeenCalledWith(
      { _id: 'el1' },
      expect.objectContaining({
        $set: expect.objectContaining({ lastLoginAt: expect.any(Date) }),
      }),
    );
    expect(h.provision).not.toHaveBeenCalled();
    expect(result?.user.id).toBe('u1');
    expect(result?.created).toBe(false);
  });

  it('T-EXT-B2: find 未命中返回 null（不再自动开户）', async () => {
    h.externalLogin.findOne.mockReturnValue(q(null));
    await expect(findExternalLogin(IDENTITY)).resolves.toBeNull();
    expect(h.provision).not.toHaveBeenCalled();
  });

  it('T-EXT-B3: bind 成功以目标用户三元组落行', async () => {
    h.externalLogin.findOne.mockReturnValue(q(null));
    const result = await bindExternalLoginToUser(USER, IDENTITY);
    expect(h.externalLogin.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER.id,
        accountId: USER.accountId,
        tenantId: USER.tenantId,
        subject: IDENTITY.subject,
      }),
    );
    expect(result.id).toBe('el1');
    expect(result.userId).toBe(USER.id);
  });

  it('T-EXT-B4: 身份已被他人绑定 → IDENTITY_ALREADY_BOUND', async () => {
    h.externalLogin.findOne.mockReturnValueOnce(q({ _id: 'el-other' }));
    await expect(bindExternalLoginToUser(USER, IDENTITY)).rejects.toMatchObject({
      code: 'IDENTITY_ALREADY_BOUND',
    });
    expect(h.externalLogin.create).not.toHaveBeenCalled();
  });

  it('T-EXT-B5: 同账户同 provider 已绑定 → PROVIDER_ALREADY_BOUND', async () => {
    h.externalLogin.findOne
      .mockReturnValueOnce(q(null))
      .mockReturnValueOnce(q({ _id: 'el-provider' }));
    await expect(bindExternalLoginToUser(USER, IDENTITY)).rejects.toMatchObject({
      code: 'PROVIDER_ALREADY_BOUND',
    });
    expect(h.externalLogin.create).not.toHaveBeenCalled();
  });

  it('T-EXT-B6: bind 并发 E11000 → 回读判定身份占用', async () => {
    h.externalLogin.findOne
      .mockReturnValueOnce(q(null))
      .mockReturnValueOnce(q(null))
      .mockReturnValueOnce(q({ _id: 'el-raced' }));
    h.externalLogin.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(bindExternalLoginToUser(USER, IDENTITY)).rejects.toBeInstanceOf(
      ExternalLoginError,
    );
  });

  it('T-EXT-B7: provision 成功开户并落 externallogins', async () => {
    const result = await provisionExternalLogin(IDENTITY);
    expect(h.provision).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'octotest', source: 'oauth' }),
    );
    expect(h.externalLogin.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', accountId: 'a1', subject: 'sub-1' }),
    );
    expect(result.created).toBe(true);
  });

  it('T-EXT-B8: provision E11000 拒绝并回滚（不再幂等吞并）', async () => {
    h.externalLogin.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    h.externalLogin.findOne.mockReturnValue(q({ _id: 'el2', userId: 'u-win' }));

    await expect(provisionExternalLogin(IDENTITY)).rejects.toMatchObject({
      code: 'IDENTITY_ALREADY_BOUND',
    });
    expect(h.rollback).toHaveBeenCalledTimes(1);
  });

  it('T-EXT-B9: unbind 正常删除（非最后一条不受限）', async () => {
    h.externalLogin.findOne.mockReturnValue(q({ _id: 'el1', accountId: USER.accountId }));
    h.externalLogin.countDocuments.mockResolvedValue(2);
    await expect(unbindExternalLogin(USER.id, '507f1f77bcf86cd799439021')).resolves.toBe(true);
    expect(h.externalLogin.deleteOne).toHaveBeenCalledWith({ _id: 'el1', userId: USER.id });
  });

  it('T-EXT-B10: 无密码账户最后一条拒绝解绑', async () => {
    h.externalLogin.findOne.mockReturnValue(q({ _id: 'el1', accountId: USER.accountId }));
    h.externalLogin.countDocuments.mockResolvedValue(1);
    h.account.findById.mockReturnValue(q({ passwordless: true }));
    await expect(unbindExternalLogin(USER.id, '507f1f77bcf86cd799439021')).rejects.toMatchObject({
      code: 'CANNOT_UNBIND_LAST_LOGIN_METHOD',
    });
    expect(h.externalLogin.deleteOne).not.toHaveBeenCalled();
  });

  it('T-EXT-B11: 有密码账户最后一条允许解绑', async () => {
    h.externalLogin.findOne.mockReturnValue(q({ _id: 'el1', accountId: USER.accountId }));
    h.externalLogin.countDocuments.mockResolvedValue(1);
    h.account.findById.mockReturnValue(q({ passwordless: false }));
    await expect(unbindExternalLogin(USER.id, '507f1f77bcf86cd799439021')).resolves.toBe(true);
  });

  it('T-EXT-B12: 非本人/不存在/非法 id → EXTERNAL_LOGIN_NOT_FOUND', async () => {
    h.externalLogin.findOne.mockReturnValue(q(null));
    await expect(unbindExternalLogin(USER.id, '507f1f77bcf86cd799439099')).rejects.toMatchObject({
      code: 'EXTERNAL_LOGIN_NOT_FOUND',
    });
    await expect(unbindExternalLogin(USER.id, 'bad-id')).rejects.toMatchObject({
      code: 'EXTERNAL_LOGIN_NOT_FOUND',
    });
    expect(h.externalLogin.deleteOne).not.toHaveBeenCalled();
  });

  it('T-EXT-B13: list 按绑定时间映射白名单字段', async () => {
    h.externalLogin.find.mockReturnValue(sortedQ([bindingDoc()]));
    const rows = await listExternalLogins(USER.id);
    expect(h.externalLogin.find).toHaveBeenCalledWith({ userId: USER.id });
    expect(rows[0]).toMatchObject({
      id: 'el1',
      providerId: IDENTITY.providerId,
      externalUsername: IDENTITY.externalUsername,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });
});
