import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  account: { findOne: vi.fn() },
  user: { findOne: vi.fn(), findById: vi.fn(), countDocuments: vi.fn() },
  tenant: { findById: vi.fn() },
  tenantMember: { countDocuments: vi.fn() },
  authProvider: { findById: vi.fn() },
  externalLogin: { findOne: vi.fn() },
  externalLoginService: {
    list: vi.fn(),
    bind: vi.fn(),
    provision: vi.fn(),
    unbind: vi.fn(),
  },
  oauthFlow: {
    getPending: vi.fn(),
    consumePending: vi.fn(),
    bumpPending: vi.fn(),
    issueFrontBind: vi.fn(),
  },
  verifyPassword: vi.fn(),
  signToken: vi.fn(),
}));

vi.mock('../../models/account.js', () => ({ Account: h.account }));
vi.mock('../../models/user.js', () => ({ User: h.user }));
vi.mock('../../models/tenant.js', () => ({ Tenant: h.tenant }));
vi.mock('../../models/tenant-member.js', () => ({ TenantMember: h.tenantMember }));
vi.mock('../../models/auth-provider.js', () => ({ AuthProvider: h.authProvider }));
vi.mock('../../models/external-login.js', () => ({ ExternalLogin: h.externalLogin }));
vi.mock('../../services/external-login.js', () => ({
  bindExternalLoginToUser: h.externalLoginService.bind,
  listExternalLogins: h.externalLoginService.list,
  provisionExternalLogin: h.externalLoginService.provision,
  unbindExternalLogin: h.externalLoginService.unbind,
  ExternalLoginError: class ExternalLoginError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock('../../services/oauth-flow.js', () => ({
  consumeLoginTicket: vi.fn(),
  getPendingIdentity: h.oauthFlow.getPending,
  consumePendingIdentity: h.oauthFlow.consumePending,
  bumpPendingFailCount: h.oauthFlow.bumpPending,
  issueFrontBindTicket: h.oauthFlow.issueFrontBind,
}));
vi.mock('../../services/provisioning.js', () => ({
  ProvisioningError: class ProvisioningError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock('../../services/auth.js', () => ({
  verifyPassword: h.verifyPassword,
  signToken: h.signToken,
}));

import { authResolvers, requireTenantId, type AuthContext } from './auth.js';

const USER_ID = '507f1f77bcf86cd799439011';

function userDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: USER_ID,
    name: 'alice',
    tenantId: USER_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('auth resolvers (three-tier account model)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.account.findOne.mockReturnValue({ lean: async () => null });
    h.user.findOne.mockResolvedValue(null);
    h.signToken.mockReturnValue('token-1');
    h.verifyPassword.mockResolvedValue(true);
    h.authProvider.findById.mockReturnValue({ lean: async () => null });
    h.externalLogin.findOne.mockReturnValue({ lean: async () => null });
    h.externalLoginService.list.mockResolvedValue([]);
    h.externalLoginService.bind.mockResolvedValue({ id: 'el1' });
    h.externalLoginService.unbind.mockResolvedValue(true);
    h.oauthFlow.issueFrontBind.mockResolvedValue('fb-ticket');
  });

  it('logs in through accounts and resolves user by accountId, token payload stays userId', async () => {
    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'h' });
    h.user.findOne.mockResolvedValue(userDoc());

    const result = await authResolvers.Mutation.login(
      undefined,
      { username: 'alice', password: 'secret1' },
    );

    expect(h.account.findOne).toHaveBeenCalledWith({ username: 'alice' });
    expect(h.verifyPassword).toHaveBeenCalledWith('secret1', 'h');
    expect(h.user.findOne).toHaveBeenCalledWith({ accountId: 'acc-1' });
    expect(h.signToken).toHaveBeenCalledWith(USER_ID);
    expect(result).toMatchObject({ token: 'token-1', user: { id: USER_ID, name: 'alice' } });
  });

  it('keeps the same error message for unknown user and wrong password', async () => {
    await expect(
      authResolvers.Mutation.login(undefined, { username: 'nobody', password: 'x' }),
    ).rejects.toThrow('Invalid username or password');

    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'h' });
    h.verifyPassword.mockResolvedValue(false);
    await expect(
      authResolvers.Mutation.login(undefined, { username: 'alice', password: 'bad' }),
    ).rejects.toThrow('Invalid username or password');
  });

  it('me returns null when unauthenticated and reads name/tenant from DB when authenticated', async () => {
    expect(await authResolvers.Query.me(undefined, undefined, { currentUser: null })).toBeNull();

    h.user.findById.mockResolvedValue(userDoc());
    const me = await authResolvers.Query.me(undefined, undefined, {
      currentUser: { id: USER_ID, tenantId: USER_ID, name: 'alice' },
    });
    expect(me).toMatchObject({ id: USER_ID, name: 'alice' });
  });

  it('User.tenant returns personal tenant with memberCount', async () => {
    h.tenant.findById.mockResolvedValue({ _id: USER_ID, name: 'alice', type: 'personal' });
    h.tenantMember.countDocuments.mockResolvedValue(1);

    const tenant = await authResolvers.User.tenant({ id: USER_ID, name: 'alice' });
    expect(tenant).toEqual({ id: USER_ID, name: 'alice', type: 'personal', memberCount: 1 });
  });

  it('User.tenant falls back to a personal view for half-migrated users', async () => {
    h.tenant.findById.mockResolvedValue(null);
    const tenant = await authResolvers.User.tenant({ id: USER_ID, name: 'alice' });
    expect(tenant).toEqual({ id: USER_ID, name: 'alice', type: 'personal', memberCount: 1 });
  });

  it('requireTenantId uses context tenantId, then currentUser.tenantId, then userId fallback', () => {
    expect(requireTenantId({ currentUser: { id: 'u1', tenantId: 't1' }, tenantId: 't1' })).toBe('t1');
    expect(requireTenantId({ currentUser: { id: 'u1', tenantId: 't1' } })).toBe('t1');
    expect(requireTenantId({ currentUser: { id: 'u1' } })).toBe('u1');
    expect(() => requireTenantId({ currentUser: null })).toThrow('Not authenticated');
  });
});

const PROVIDER_ID = '507f1f77bcf86cd799439099';
const CONTEXT: AuthContext = {
  currentUser: { id: USER_ID, tenantId: USER_ID, name: 'alice' },
  tenantId: USER_ID,
};
const PENDING = {
  providerId: PROVIDER_ID,
  issuer: 'http://idp',
  subject: 'sub-1',
  externalUsername: 'octo',
  displayName: 'Octo',
  avatarUrl: null,
  failCount: 0,
};

function providerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROVIDER_ID,
    type: 'oidc',
    displayName: '公司 SSO',
    enabled: true,
    enableFrontLogin: true,
    ...overrides,
  };
}

describe('外部身份绑定 resolvers（T-OBO）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.signToken.mockReturnValue('token-1');
    h.oauthFlow.issueFrontBind.mockResolvedValue('fb-ticket');
    h.externalLoginService.bind.mockResolvedValue({ id: 'el1' });
    h.externalLoginService.list.mockResolvedValue([]);
    h.externalLoginService.unbind.mockResolvedValue(true);
    h.externalLogin.findOne.mockReturnValue({ lean: async () => null });
  });

  it('T-OBO1: pendingExternalLoginInfo 不消费且返回白名单两字段', async () => {
    h.oauthFlow.getPending.mockResolvedValue(PENDING);
    h.authProvider.findById.mockReturnValue({ lean: async () => providerDoc() });

    const info = await authResolvers.Query.pendingExternalLoginInfo(undefined, {
      pendingToken: 'p1',
    });
    expect(info).toEqual({ providerDisplayName: '公司 SSO', externalUsername: 'octo' });
    expect(h.oauthFlow.consumePending).not.toHaveBeenCalled();

    h.oauthFlow.getPending.mockResolvedValue(null);
    expect(
      await authResolvers.Query.pendingExternalLoginInfo(undefined, { pendingToken: 'x' }),
    ).toBeNull();
  });

  it('T-OBO2: bindExternalLoginWithPassword 验密成功 → 落绑定、消费 pending、签发 token', async () => {
    h.oauthFlow.getPending.mockResolvedValue(PENDING);
    h.authProvider.findById.mockReturnValue({ lean: async () => providerDoc() });
    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'h' });
    h.user.findOne.mockResolvedValue(userDoc());
    h.verifyPassword.mockResolvedValue(true);

    const result = await authResolvers.Mutation.bindExternalLoginWithPassword(undefined, {
      pendingToken: 'p1',
      username: 'alice',
      password: 'secret1',
    });

    expect(h.externalLoginService.bind).toHaveBeenCalledWith(
      { id: USER_ID, accountId: 'acc-1', tenantId: USER_ID },
      expect.objectContaining({ subject: 'sub-1' }),
    );
    expect(h.oauthFlow.consumePending).toHaveBeenCalledWith('p1');
    expect(h.signToken).toHaveBeenCalledWith(USER_ID);
    expect(result).toMatchObject({ token: 'token-1', user: { id: USER_ID } });
  });

  it('T-OBO3: 验密失败计次且不消费 pending（文案与 login 一致）', async () => {
    h.oauthFlow.getPending.mockResolvedValue(PENDING);
    h.authProvider.findById.mockReturnValue({ lean: async () => providerDoc() });
    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'h' });
    h.user.findOne.mockResolvedValue(userDoc());
    h.verifyPassword.mockResolvedValue(false);

    await expect(
      authResolvers.Mutation.bindExternalLoginWithPassword(undefined, {
        pendingToken: 'p1',
        username: 'alice',
        password: 'bad',
      }),
    ).rejects.toThrow('Invalid username or password');
    expect(h.oauthFlow.bumpPending).toHaveBeenCalledWith('p1');
    expect(h.oauthFlow.consumePending).not.toHaveBeenCalled();
    expect(h.externalLoginService.bind).not.toHaveBeenCalled();
  });

  it('T-OBO4: pending 过期 / provider 停用 / 身份冲突 → 契约文案', async () => {
    h.oauthFlow.getPending.mockResolvedValue(null);
    await expect(
      authResolvers.Mutation.bindExternalLoginWithPassword(undefined, {
        pendingToken: 'x',
        username: 'a',
        password: 'b',
      }),
    ).rejects.toThrow('invalid or expired pending token');

    h.oauthFlow.getPending.mockResolvedValue(PENDING);
    h.authProvider.findById.mockReturnValue({ lean: async () => providerDoc({ enabled: false }) });
    await expect(
      authResolvers.Mutation.provisionExternalLogin(undefined, { pendingToken: 'p1' }),
    ).rejects.toThrow('provider unavailable');

    h.authProvider.findById.mockReturnValue({ lean: async () => providerDoc() });
    const { ExternalLoginError: Err } = await import('../../services/external-login.js');
    h.externalLoginService.provision.mockRejectedValue(new Err('IDENTITY_ALREADY_BOUND'));
    await expect(
      authResolvers.Mutation.provisionExternalLogin(undefined, { pendingToken: 'p1' }),
    ).rejects.toThrow('identity already bound');
    expect(h.oauthFlow.consumePending).not.toHaveBeenCalled();
  });

  it('T-OBO5: provisionExternalLogin 成功消费 pending 并返回 AuthPayload', async () => {
    h.oauthFlow.getPending.mockResolvedValue(PENDING);
    h.authProvider.findById.mockReturnValue({ lean: async () => providerDoc() });
    h.externalLoginService.provision.mockResolvedValue({
      user: { id: USER_ID, name: 'alice', tenantId: USER_ID, createdAt: '2026-01-01' },
      account: { id: 'acc-1', username: 'alice' },
      created: true,
    });

    const result = await authResolvers.Mutation.provisionExternalLogin(undefined, {
      pendingToken: 'p1',
    });
    expect(h.externalLoginService.provision).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'sub-1' }),
    );
    expect(h.oauthFlow.consumePending).toHaveBeenCalledWith('p1');
    expect(result).toMatchObject({ token: 'token-1', user: { id: USER_ID } });
  });

  it('T-OBO6: myExternalLogins 需登录并委托服务', async () => {
    await expect(
      authResolvers.Query.myExternalLogins(undefined, undefined, { currentUser: null }),
    ).rejects.toThrow('Not authenticated');
    await authResolvers.Query.myExternalLogins(undefined, undefined, CONTEXT);
    expect(h.externalLoginService.list).toHaveBeenCalledWith(USER_ID);
  });

  it('T-OBO7: createFrontBindTicket provider 校验与重复绑定', async () => {
    h.authProvider.findById.mockReturnValue({ lean: async () => providerDoc() });
    await expect(
      authResolvers.Mutation.createFrontBindTicket(undefined, { providerId: PROVIDER_ID }, CONTEXT),
    ).resolves.toBe('fb-ticket');
    expect(h.oauthFlow.issueFrontBind).toHaveBeenCalledWith({
      userId: USER_ID,
      providerId: PROVIDER_ID,
    });

    h.externalLogin.findOne.mockReturnValue({ lean: async () => ({ _id: 'el1' }) });
    await expect(
      authResolvers.Mutation.createFrontBindTicket(undefined, { providerId: PROVIDER_ID }, CONTEXT),
    ).rejects.toThrow('provider already bound');
  });

  it('T-OBO8: unbindExternalLogin 委托服务并映射防呆/不存在文案', async () => {
    await expect(
      authResolvers.Mutation.unbindExternalLogin(undefined, { id: 'el1' }, CONTEXT),
    ).resolves.toBe(true);
    expect(h.externalLoginService.unbind).toHaveBeenCalledWith(USER_ID, 'el1');

    const { ExternalLoginError: Err } = await import('../../services/external-login.js');
    h.externalLoginService.unbind.mockRejectedValueOnce(
      new Err('CANNOT_UNBIND_LAST_LOGIN_METHOD'),
    );
    await expect(
      authResolvers.Mutation.unbindExternalLogin(undefined, { id: 'el1' }, CONTEXT),
    ).rejects.toThrow('cannot unbind last login method');

    h.externalLoginService.unbind.mockRejectedValueOnce(new Err('EXTERNAL_LOGIN_NOT_FOUND'));
    await expect(
      authResolvers.Mutation.unbindExternalLogin(undefined, { id: 'el2' }, CONTEXT),
    ).rejects.toThrow('external login not found');
  });

  it('T-OBO9: ExternalLoginInfo 字段 resolver 命中/回退快照', async () => {
    h.authProvider.findById.mockReturnValue({ lean: async () => providerDoc() });
    await expect(
      authResolvers.ExternalLoginInfo.providerDisplayName({
        providerId: PROVIDER_ID,
        externalUsername: 'octo',
      }),
    ).resolves.toBe('公司 SSO');
    await expect(
      authResolvers.ExternalLoginInfo.providerEnabled({ providerId: PROVIDER_ID }),
    ).resolves.toBe(true);

    h.authProvider.findById.mockReturnValue({ lean: async () => null });
    await expect(
      authResolvers.ExternalLoginInfo.providerDisplayName({
        providerId: PROVIDER_ID,
        externalUsername: 'octo',
      }),
    ).resolves.toBe('octo');
    await expect(
      authResolvers.ExternalLoginInfo.providerEnabled({ providerId: PROVIDER_ID }),
    ).resolves.toBe(false);
    await expect(
      authResolvers.ExternalLoginInfo.providerType({ providerId: PROVIDER_ID }),
    ).resolves.toBe('oidc');
  });
});
