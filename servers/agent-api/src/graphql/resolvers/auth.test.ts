import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  account: { findOne: vi.fn() },
  user: { findOne: vi.fn(), findById: vi.fn(), countDocuments: vi.fn() },
  tenant: { findById: vi.fn() },
  verifyPassword: vi.fn(),
  signToken: vi.fn(),
}));

vi.mock('../../models/account.js', () => ({ Account: h.account }));
vi.mock('../../models/user.js', () => ({ User: h.user }));
vi.mock('../../models/tenant.js', () => ({ Tenant: h.tenant }));
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
  });

  it('logs in through accounts and resolves user by accountId, token payload stays userId', async () => {
    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'h' });
    h.user.findOne.mockResolvedValue(userDoc());

    const result = await authResolvers.Mutation.login(
      undefined,
      { username: 'alice', password: 'secret1' },
      {} as AuthContext,
    );

    expect(h.account.findOne).toHaveBeenCalledWith({ username: 'alice' });
    expect(h.verifyPassword).toHaveBeenCalledWith('secret1', 'h');
    expect(h.user.findOne).toHaveBeenCalledWith({ accountId: 'acc-1' });
    expect(h.signToken).toHaveBeenCalledWith(USER_ID);
    expect(result).toMatchObject({ token: 'token-1', user: { id: USER_ID, name: 'alice' } });
  });

  it('keeps the same error message for unknown user and wrong password', async () => {
    await expect(
      authResolvers.Mutation.login(undefined, { username: 'nobody', password: 'x' }, {} as AuthContext),
    ).rejects.toThrow('Invalid username or password');

    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'h' });
    h.verifyPassword.mockResolvedValue(false);
    await expect(
      authResolvers.Mutation.login(undefined, { username: 'alice', password: 'bad' }, {} as AuthContext),
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
    h.user.countDocuments.mockResolvedValue(1);

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
