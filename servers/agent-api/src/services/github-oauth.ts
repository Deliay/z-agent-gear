import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import type { NormalizedIdentity } from './oidc-client.js';

const logger = rootLogger.child({ component: 'github-oauth' });

export const GITHUB_OAUTH_SCOPE = 'read:user user:email';

export class GithubOauthError extends Error {
  readonly code: 'provider_error';

  constructor(message: string) {
    super(message);
    this.code = 'provider_error';
    this.name = 'GithubOauthError';
  }
}

export interface GithubProviderConfig {
  clientId: string;
  clientSecret: string;
}

export interface GithubIdentity extends NormalizedIdentity {
  avatarUrl: string | null;
}

/** 组装 GitHub OAuth 授权 URL（恒仅 state，无 PKCE）。 */
export function buildGithubAuthorizationUrl(
  provider: GithubProviderConfig,
  options: { redirectUri: string; state: string },
): URL {
  const url = new URL(config.githubOauthAuthorizeUrl);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', GITHUB_OAUTH_SCOPE);
  url.searchParams.set('state', options.state);
  return url;
}

/** code → access_token（token 仅内存使用，不落库、不入日志）。 */
async function exchangeCode(
  provider: GithubProviderConfig,
  code: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetch(config.githubOauthTokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new GithubOauthError(`GitHub token endpoint returned ${response.status}`);
  }
  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!payload.access_token) {
    throw new GithubOauthError(payload.error_description || payload.error || 'missing access_token');
  }
  return payload.access_token;
}

interface GithubUserResponse {
  id?: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}

/** code → 归一身份（subject = GitHub 数字 id 字符串化；不以邮箱为锚点）。 */
export async function exchangeGithubCode(
  provider: GithubProviderConfig,
  options: { code: string; redirectUri: string },
): Promise<GithubIdentity> {
  const accessToken = await exchangeCode(provider, options.code, options.redirectUri);
  try {
    const response = await fetch(`${config.githubOauthApiBase}/user`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'z-agent-gear',
      },
    });
    if (!response.ok) {
      throw new GithubOauthError(`GitHub user endpoint returned ${response.status}`);
    }
    const user = (await response.json()) as GithubUserResponse;
    if (typeof user.id !== 'number' || !user.login) {
      throw new GithubOauthError('GitHub user response missing id/login');
    }
    const login = user.login;
    return {
      subject: String(user.id),
      externalUsername: login,
      displayName: user.name || login,
      avatarUrl: user.avatar_url ?? null,
    };
  } catch (err) {
    if (err instanceof GithubOauthError) throw err;
    logger.warn({ err }, 'GitHub user fetch failed');
    throw new GithubOauthError((err as Error).message);
  }
}

export function githubRedirectUri(): string {
  return `${config.publicBaseUrl}/api/auth/oauth/callback`;
}
