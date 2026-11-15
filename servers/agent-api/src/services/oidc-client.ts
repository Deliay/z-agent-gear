import * as client from 'openid-client';
import type { Configuration } from 'openid-client';
import { config as appConfig } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { getRedisClient } from '../middleware/redis.js';

const logger = rootLogger.child({ component: 'oidc-client' });

const DISCOVERY_TTL_SECONDS = 3600;
const JWKS_TTL_SECONDS = 3600;

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

export interface NormalizedIdentity {
  subject: string;
  externalUsername: string;
  displayName: string | null;
}

export class OidcError extends Error {
  readonly code: 'provider_error';

  constructor(message: string) {
    super(message);
    this.code = 'provider_error';
    this.name = 'OidcError';
  }
}

/**
 * OIDC discovery/JWKS Redis 缓存（1h）：仅缓存 GET 的 discovery 与 JWKS 文档，
 * token 交换等 POST 请求直连。验签失败时由 `exchangeOidcCode` 丢弃缓存强刷一次。
 */
function createCachingFetch() {
  return async (url: string, options: client.CustomFetchOptions): Promise<Response> => {
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET') return fetch(url, options as RequestInit);

    const isDiscovery = url.includes('/.well-known/openid-configuration');
    const isJwks = /\/jwks\b|\/jwks\.json\b|\/certs\b/.test(url);
    if (!isDiscovery && !isJwks) return fetch(url, options as RequestInit);

    const key = isDiscovery ? `oidc:discovery:${url}` : `oidc:jwks:${url}`;
    const ttl = isDiscovery ? DISCOVERY_TTL_SECONDS : JWKS_TTL_SECONDS;
    try {
      const cached = await getRedisClient().get(key);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    } catch {
      // Redis 不可用时退化为直连（不阻塞登录）
    }

    const response = await fetch(url, options as RequestInit);
    if (response.ok) {
      const text = await response.clone().text();
      void getRedisClient()
        .set(key, text, 'EX', ttl)
        .catch(() => undefined);
    }
    return response;
  };
}

/** 清空某 issuer 的 discovery/JWKS 缓存（验签失败强刷一次）。 */
export async function invalidateOidcCache(issuer: string): Promise<void> {
  try {
    const redis = getRedisClient();
    const normalized = issuer.replace(/\/+$/, '');
    const keys = [
      `oidc:discovery:${normalized}/.well-known/openid-configuration`,
      `oidc:jwks:${normalized}/jwks`,
      `oidc:jwks:${normalized}/jwks.json`,
    ];
    await redis.del(...keys);
  } catch {
    // 缓存清理失败不影响重试
  }
}

async function resolveConfiguration(provider: OidcProviderConfig): Promise<Configuration> {
  const issuer = provider.issuer.replace(/\/+$/, '');
  const options: client.DiscoveryRequestOptions = {
    [client.customFetch]: createCachingFetch(),
  };
  if (issuer.startsWith('http://')) {
    // 开发/fake IdP 允许 http；生产校验已在 admin-api 配置侧强制 https。
    options.execute = [client.allowInsecureRequests];
  }
  return client.discovery(new URL(issuer), provider.clientId, provider.clientSecret, undefined, options);
}

export interface BuildAuthorizeUrlResult {
  url: URL;
  codeVerifier?: string;
  nonce: string;
  /** discovery 未宣告 S256 时降级为仅 state+nonce（info 记录降级）。 */
  pkce: boolean;
}

/** 组装 OIDC 授权 URL（PKCE S256 + nonce；不支持 PKCE 时降级）。 */
export async function buildOidcAuthorizationUrl(
  provider: OidcProviderConfig,
  options: { redirectUri: string; state: string },
): Promise<BuildAuthorizeUrlResult> {
  const configuration = await resolveConfiguration(provider);
  const metadata = configuration.serverMetadata();
  const methods = (metadata as { code_challenge_methods_supported?: string[] })
    .code_challenge_methods_supported;
  const supportsPkce = Array.isArray(methods) && methods.includes('S256');
  const nonce = client.randomNonce();

  const parameters: Record<string, string> = {
    redirect_uri: options.redirectUri,
    scope: provider.scopes || 'openid profile email',
    state: options.state,
    nonce,
    response_type: 'code',
  };

  let codeVerifier: string | undefined;
  if (supportsPkce) {
    codeVerifier = client.randomPKCECodeVerifier();
    parameters.code_challenge = await client.calculatePKCECodeChallenge(codeVerifier);
    parameters.code_challenge_method = 'S256';
  } else {
    logger.info(
      { issuer: provider.issuer },
      'IDP does not advertise S256 PKCE, falling back to state+nonce',
    );
  }

  return {
    url: client.buildAuthorizationUrl(configuration, parameters),
    codeVerifier,
    nonce,
    pkce: supportsPkce,
  };
}

/** claims 归一（D11）：username = preferred_username ?? email 本地段 ?? sub 前 8。 */
export function normalizeOidcClaims(claims: Record<string, unknown>): NormalizedIdentity {
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) throw new OidcError('id_token missing sub claim');
  const preferred = typeof claims.preferred_username === 'string' ? claims.preferred_username : '';
  const email = typeof claims.email === 'string' ? claims.email : '';
  const emailLocal = email.includes('@') ? email.slice(0, email.indexOf('@')) : email;
  const name = typeof claims.name === 'string' ? claims.name : '';
  return {
    subject: sub,
    externalUsername: preferred || emailLocal || sub.slice(0, 8),
    displayName: name || preferred || null,
  };
}

/**
 * code 交换 + id_token 验签（iss 精确 / aud 含 clientId / exp / nonce 由 openid-client 校验）。
 * 验签失败强刷一次 discovery/JWKS 缓存后重试。
 */
export async function exchangeOidcCode(
  provider: OidcProviderConfig,
  callbackUrl: URL,
  options: { state: string; codeVerifier?: string; nonce?: string },
): Promise<NormalizedIdentity> {
  async function attempt(): Promise<NormalizedIdentity> {
    const configuration = await resolveConfiguration(provider);
    const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
      expectedState: options.state,
      expectedNonce: options.nonce,
      pkceCodeVerifier: options.codeVerifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new OidcError('id_token missing');
    return normalizeOidcClaims(claims as unknown as Record<string, unknown>);
  }

  try {
    return await attempt();
  } catch (err) {
    logger.warn({ err, issuer: provider.issuer }, 'oidc token exchange failed, refreshing jwks and retrying once');
    await invalidateOidcCache(provider.issuer);
    try {
      return await attempt();
    } catch (retryErr) {
      logger.warn({ err: retryErr, issuer: provider.issuer }, 'oidc token exchange retry failed');
      throw new OidcError((retryErr as Error).message);
    }
  }
}

/** 对外回调地址唯一事实源：`{PUBLIC_BASE_URL}/api/auth/oauth/callback`。 */
export function oidcRedirectUri(): string {
  return `${appConfig.publicBaseUrl}/api/auth/oauth/callback`;
}
