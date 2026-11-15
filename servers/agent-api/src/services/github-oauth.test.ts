import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../config/index.js';
import {
  buildGithubAuthorizationUrl,
  exchangeGithubCode,
  GithubOauthError,
} from './github-oauth.js';

const original = { ...config };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('github-oauth（T-GHO）', () => {
  beforeEach(() => {
    config.githubOauthAuthorizeUrl = 'http://127.0.0.1:19418/login/oauth/authorize';
    config.githubOauthTokenUrl = 'http://127.0.0.1:19418/login/oauth/access_token';
    config.githubOauthApiBase = 'http://127.0.0.1:19418';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.assign(config, original);
    vi.unstubAllGlobals();
  });

  it('T-GHO1: authorize URL 携带 client_id/redirect_uri/scope/state', () => {
    const url = buildGithubAuthorizationUrl(
      { clientId: 'cid', clientSecret: 'sec' },
      { redirectUri: 'http://api/cb', state: 's1' },
    );
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:19418/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('http://api/cb');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('state')).toBe('s1');
  });

  it('T-GHO2: code → token → /user 归一（subject=数字 id）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 1001, login: 'octo-test', name: 'Octo Test', avatar_url: 'a' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const identity = await exchangeGithubCode(
      { clientId: 'cid', clientSecret: 'sec' },
      { code: 'c1', redirectUri: 'http://api/cb' },
    );
    expect(identity).toEqual({
      subject: '1001',
      externalUsername: 'octo-test',
      displayName: 'Octo Test',
      avatarUrl: 'a',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(config.githubOauthTokenUrl);
    expect(fetchMock.mock.calls[1][0]).toBe(`${config.githubOauthApiBase}/user`);
  });

  it('T-GHO3: token 端点失败抛 provider_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'bad' }, 500)));
    await expect(
      exchangeGithubCode({ clientId: 'c', clientSecret: 's' }, { code: 'x', redirectUri: 'u' }),
    ).rejects.toBeInstanceOf(GithubOauthError);
  });

  it('T-GHO4: /user 缺 id/login 抛 provider_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }))
        .mockResolvedValueOnce(jsonResponse({ login: 'no-id' })),
    );
    await expect(
      exchangeGithubCode({ clientId: 'c', clientSecret: 's' }, { code: 'x', redirectUri: 'u' }),
    ).rejects.toBeInstanceOf(GithubOauthError);
  });
});
