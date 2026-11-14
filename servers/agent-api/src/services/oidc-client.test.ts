import { describe, it, expect, vi, beforeEach } from 'vitest';

const oc = vi.hoisted(() => ({
  discovery: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  randomNonce: vi.fn(() => 'nonce-1'),
  randomPKCECodeVerifier: vi.fn(() => 'verifier-1'),
  calculatePKCECodeChallenge: vi.fn(async () => 'challenge-1'),
  authorizationCodeGrant: vi.fn(),
  allowInsecureRequests: vi.fn(),
  customFetch: Symbol('customFetch'),
}));

vi.mock('openid-client', () => oc);
vi.mock('../middleware/redis.js', () => ({
  getRedisClient: () => ({ get: vi.fn(async () => null), set: vi.fn(), del: vi.fn() }),
}));

import {
  buildOidcAuthorizationUrl,
  exchangeOidcCode,
  normalizeOidcClaims,
  OidcError,
  oidcRedirectUri,
} from './oidc-client.js';

function discoveryConfig(codeChallengeMethods?: string[]) {
  return {
    serverMetadata: () => ({ issuer: 'http://idp', code_challenge_methods_supported: codeChallengeMethods }),
  };
}

const PROVIDER = {
  issuer: 'http://idp',
  clientId: 'cid',
  clientSecret: 'secret',
  scopes: 'openid profile email',
};

describe('normalizeOidcClaims', () => {
  it('优先 preferred_username', () => {
    expect(
      normalizeOidcClaims({ sub: 'abc123', preferred_username: 'alice', email: 'a@b.com', name: 'Alice' }),
    ).toEqual({ subject: 'abc123', externalUsername: 'alice', displayName: 'Alice' });
  });

  it('回退 email 本地段', () => {
    expect(normalizeOidcClaims({ sub: 'abc123', email: 'bob@example.com' })).toEqual({
      subject: 'abc123',
      externalUsername: 'bob',
      displayName: null,
    });
  });

  it('再回退 sub 前 8', () => {
    expect(normalizeOidcClaims({ sub: '1234567890' })).toEqual({
      subject: '1234567890',
      externalUsername: '12345678',
      displayName: null,
    });
  });

  it('缺少 sub 抛 OidcError', () => {
    expect(() => normalizeOidcClaims({})).toThrow(OidcError);
  });
});

describe('OIDC 授权/回调（T-OIDC）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-OIDC1: 支持 S256 时带 PKCE + nonce', async () => {
    oc.discovery.mockResolvedValue(discoveryConfig(['S256']));
    oc.buildAuthorizationUrl.mockReturnValue(new URL('http://idp/authorize?state=s1'));

    const result = await buildOidcAuthorizationUrl(PROVIDER, {
      redirectUri: 'http://api/callback',
      state: 's1',
    });

    expect(result.pkce).toBe(true);
    expect(result.nonce).toBe('nonce-1');
    expect(result.codeVerifier).toBe('verifier-1');
    const params = oc.buildAuthorizationUrl.mock.calls[0][1] as Record<string, string>;
    expect(params).toMatchObject({
      state: 's1',
      nonce: 'nonce-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      response_type: 'code',
    });
  });

  it('T-OIDC2: discovery 未宣告 S256 时降级为仅 state+nonce', async () => {
    oc.discovery.mockResolvedValue(discoveryConfig([]));
    oc.buildAuthorizationUrl.mockReturnValue(new URL('http://idp/authorize'));

    const result = await buildOidcAuthorizationUrl(PROVIDER, {
      redirectUri: 'http://api/callback',
      state: 's1',
    });

    expect(result.pkce).toBe(false);
    expect(result.codeVerifier).toBeUndefined();
    const params = oc.buildAuthorizationUrl.mock.calls[0][1] as Record<string, string>;
    expect(params.code_challenge).toBeUndefined();
    expect(params.nonce).toBe('nonce-1');
  });

  it('T-OIDC3: 回调交换把 state/nonce/code_verifier 传给 openid-client 校验', async () => {
    oc.discovery.mockResolvedValue(discoveryConfig(['S256']));
    oc.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: 'sub-1', preferred_username: 'alice', name: 'Alice' }),
    });

    const identity = await exchangeOidcCode(
      PROVIDER,
      new URL('http://api/callback?code=c1&state=s1'),
      { state: 's1', codeVerifier: 'v1', nonce: 'n1' },
    );

    expect(identity).toEqual({ subject: 'sub-1', externalUsername: 'alice', displayName: 'Alice' });
    expect(oc.authorizationCodeGrant.mock.calls[0][2]).toMatchObject({
      expectedState: 's1',
      expectedNonce: 'n1',
      pkceCodeVerifier: 'v1',
      idTokenExpected: true,
    });
  });

  it('T-OIDC4: 缺 id_token → provider_error', async () => {
    oc.discovery.mockResolvedValue(discoveryConfig(['S256']));
    oc.authorizationCodeGrant.mockResolvedValue({ claims: () => undefined });
    await expect(
      exchangeOidcCode(PROVIDER, new URL('http://api/cbv?code=c&state=s'), {
        state: 's',
      }),
    ).rejects.toBeInstanceOf(OidcError);
  });

  it('T-OIDC5: 首次交换失败会强刷缓存并重试一次', async () => {
    oc.discovery.mockResolvedValue(discoveryConfig(['S256']));
    oc.authorizationCodeGrant
      .mockRejectedValueOnce(new Error('bad signature'))
      .mockResolvedValueOnce({ claims: () => ({ sub: 'sub-2' }) });

    const identity = await exchangeOidcCode(PROVIDER, new URL('http://api/cb?code=c&state=s'), {
      state: 's',
    });
    expect(identity.subject).toBe('sub-2');
    expect(oc.authorizationCodeGrant).toHaveBeenCalledTimes(2);
  });

  it('T-OIDC6: 重试仍失败 → OidcError', async () => {
    oc.discovery.mockResolvedValue(discoveryConfig(['S256']));
    oc.authorizationCodeGrant.mockRejectedValue(new Error('still bad'));
    await expect(
      exchangeOidcCode(PROVIDER, new URL('http://api/cb?code=c&state=s'), { state: 's' }),
    ).rejects.toBeInstanceOf(OidcError);
  });

  it('T-OIDC7: redirect_uri 由 PUBLIC_BASE_URL 派生', () => {
    expect(oidcRedirectUri()).toMatch(/\/api\/auth\/oauth\/callback$/);
  });
});
