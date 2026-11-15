import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';

const h = vi.hoisted(() => ({
  service: {
    listOidcProviders: vi.fn(),
    getGithubConfig: vi.fn(),
    createOidcProvider: vi.fn(),
    updateOidcProvider: vi.fn(),
    deleteOidcProvider: vi.fn(),
    upsertGithubConfig: vi.fn(),
  },
}));

vi.mock('../../services/auth-provider.js', () => ({ authProviderService: h.service }));

import { authProviderResolvers } from './auth-provider.js';

const ADMIN = { id: 'a1', username: 'admin', mustChangePassword: false };
const CONTEXT = { currentAdmin: ADMIN };

describe('auth-provider resolver 守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('未认证 → UNAUTHENTICATED', async () => {
    await expect(
      authProviderResolvers.Query.oidcProviders({}, {}, { currentAdmin: null }),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(h.service.listOidcProviders).not.toHaveBeenCalled();
  });

  it('mustChangePassword → MUST_CHANGE_PASSWORD', async () => {
    await expect(
      authProviderResolvers.Query.githubOauthConfig(
        {},
        {},
        { currentAdmin: { ...ADMIN, mustChangePassword: true } },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'MUST_CHANGE_PASSWORD' } });
  });

  it('已认证 → 委托 service', async () => {
    h.service.listOidcProviders.mockResolvedValue([{ id: 'p1' }]);
    h.service.createOidcProvider.mockResolvedValue({ id: 'p1' });
    await expect(authProviderResolvers.Query.oidcProviders({}, {}, CONTEXT)).resolves.toEqual([
      { id: 'p1' },
    ]);
    await expect(
      authProviderResolvers.Mutation.createOidcProvider({}, { input: {} }, CONTEXT),
    ).resolves.toEqual({ id: 'p1' });
  });

  it('service 抛错 → GraphQLError', async () => {
    h.service.createOidcProvider.mockRejectedValue(new Error('bad input'));
    await expect(
      authProviderResolvers.Mutation.createOidcProvider({}, { input: {} }, CONTEXT),
    ).rejects.toBeInstanceOf(GraphQLError);
  });

  it('更新不存在 → OIDC Provider not found', async () => {
    h.service.updateOidcProvider.mockResolvedValue(null);
    await expect(
      authProviderResolvers.Mutation.updateOidcProvider({}, { id: 'p1', input: {} }, CONTEXT),
    ).rejects.toThrow('OIDC Provider not found');
  });
});
