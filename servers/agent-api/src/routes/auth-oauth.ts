import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { AuthProvider } from '../models/auth-provider.js';
import { decrypt } from '../services/crypto.js';
import {
  buildOidcAuthorizationUrl,
  exchangeOidcCode,
  OidcError,
  oidcRedirectUri,
} from '../services/oidc-client.js';
import {
  buildGithubAuthorizationUrl,
  exchangeGithubCode,
  GithubOauthError,
  githubRedirectUri,
} from '../services/github-oauth.js';
import {
  consumeFrontBindTicket,
  consumeState,
  issueLoginTicket,
  issuePendingIdentity,
  issueState,
  randomToken,
  type OAuthSurface,
  type OAuthStatePayload,
} from '../services/oauth-flow.js';
import {
  bindExternalLoginToUser,
  ExternalLoginError,
  findExternalLogin,
} from '../services/external-login.js';
import { ProvisioningError } from '../services/provisioning.js';
import { signToken } from '../services/auth.js';
import { User } from '../models/user.js';

const logger = rootLogger.child({ component: 'auth-oauth' });

const SURFACES: readonly OAuthSurface[] = ['front', 'admin', 'admin-bind', 'front-bind'];

interface ProviderDoc {
  _id: { toString(): string };
  type: 'oidc' | 'github_oauth';
  displayName: string;
  issuer?: string | null;
  clientId: string;
  encryptedClientSecret: { iv: string; ciphertext: string; tag: string };
  scopes?: string | null;
  enabled: boolean;
  enableFrontLogin: boolean;
  enableAdminLogin: boolean;
}

function isSurface(value: unknown): value is OAuthSurface {
  return typeof value === 'string' && (SURFACES as readonly string[]).includes(value);
}

function loginUrl(surface: OAuthSurface, error: string): string {
  if (surface === 'admin' || surface === 'admin-bind') {
    return surface === 'admin'
      ? `${config.adminFrontendUrl}/login?error=${encodeURIComponent(error)}`
      : `${config.adminFrontendUrl}/settings/security?bind=error&error=${encodeURIComponent(error)}`;
  }
  if (surface === 'front-bind') {
    return `${config.frontendUrl}/settings?bind=error&error=${encodeURIComponent(error)}`;
  }
  return `${config.frontendUrl}/login?error=${encodeURIComponent(error)}`;
}

function redirectError(res: Response, surface: OAuthSurface, code: string): void {
  res.redirect(302, loginUrl(surface, code));
}

/** 302 登录页并尽力清理/消费 state（state 不可用时不阻塞）。 */
function redirectCallbackError(res: Response, code: string): void {
  redirectError(res, 'front', code);
}

async function loadProvider(providerId: string): Promise<ProviderDoc | null> {
  if (!mongoose.Types.ObjectId.isValid(providerId)) return null;
  return (await AuthProvider.findById(providerId).lean()) as unknown as ProviderDoc | null;
}

function providerAllowsSurface(provider: ProviderDoc, surface: OAuthSurface | null): boolean {
  if (!provider.enabled) return false;
  if (surface === 'front' || surface === 'front-bind') return provider.enableFrontLogin;
  if (surface === 'admin' || surface === 'admin-bind') return provider.enableAdminLogin;
  return false;
}

function oidcConfig(provider: ProviderDoc) {
  return {
    issuer: provider.issuer ?? '',
    clientId: provider.clientId,
    clientSecret: decrypt(provider.encryptedClientSecret),
    scopes: provider.scopes || 'openid profile email',
  };
}

async function callAdminApi(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  if (!config.adminApiUrl) {
    throw new Error('ADMIN_API_UNAVAILABLE');
  }
  const response = await fetch(`${config.adminApiUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.internalApiToken}`,
    },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

/**
 * 第三方登录 OAuth/OIDC 唯一 REST 入口（agent-api）。
 *
 * - authorize：校验 provider/surface → 写 state（OIDC +PKCE/nonce）→ 302 授权页；
 * - callback：验 state（GETDEL）→ code 换身份 → 归一 → 按 surface 分流；
 * - 错误一律 302 回登录页/设置页带 error code（浏览器场景不回 JSON）。
 */
export const authOauthRouter = Router();

authOauthRouter.get('/auth/oauth/:providerId/authorize', async (req: Request, res: Response) => {
  const surfaceParam = req.query.surface;
  const surface = isSurface(surfaceParam) ? surfaceParam : null;
  if (!surface) {
    redirectError(res, 'front', 'invalid_request');
    return;
  }

  const bindTicket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  if ((surface === 'admin-bind' || surface === 'front-bind') && !bindTicket) {
    redirectError(res, surface, 'invalid_request');
    return;
  }

  const provider = await loadProvider(String(req.params.providerId ?? ''));
  if (!provider || !providerAllowsSurface(provider, surface)) {
    redirectError(res, surface, 'provider_unavailable');
    return;
  }

  try {
    let authorizeUrl: URL;
    const statePayload: OAuthStatePayload = {
      providerId: provider._id.toString(),
      surface,
      ...(surface === 'admin-bind' || surface === 'front-bind' ? { bindTicket } : {}),
    };

    if (provider.type === 'oidc') {
      // OIDC：state 先生成，URL 内同时携带 state/nonce/PKCE，随后把 verifier/nonce 写入 state
      const state = randomToken();
      const built = await buildOidcAuthorizationUrl(oidcConfig(provider), {
        redirectUri: oidcRedirectUri(),
        state,
      });
      await issueState(
        { ...statePayload, codeVerifier: built.codeVerifier, nonce: built.nonce },
        state,
      );
      authorizeUrl = built.url;
    } else {
      const state = await issueState(statePayload);
      authorizeUrl = buildGithubAuthorizationUrl(
        { clientId: provider.clientId, clientSecret: decrypt(provider.encryptedClientSecret) },
        { redirectUri: githubRedirectUri(), state },
      );
    }

    res.redirect(302, authorizeUrl.toString());
  } catch (err) {
    logger.warn({ err, providerId: req.params.providerId, surface }, 'oauth authorize failed');
    redirectError(res, surface, 'provider_error');
  }
});

authOauthRouter.get('/auth/oauth/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const stateParam = typeof req.query.state === 'string' ? req.query.state : '';
  const providerError = typeof req.query.error === 'string' ? req.query.error : '';

  // 用户取消授权等：消费 state 清理，回登录页提示
  if (providerError) {
    const payload = stateParam ? await consumeState(stateParam).catch(() => null) : null;
    const surface = payload?.surface ?? 'front';
    redirectError(res, surface, providerError === 'access_denied' ? 'access_denied' : 'provider_error');
    return;
  }

  if (!stateParam || !code) {
    redirectCallbackError(res, 'invalid_state');
    return;
  }

  const statePayload = await consumeState(stateParam).catch(() => null);
  if (!statePayload) {
    redirectCallbackError(res, 'invalid_state');
    return;
  }
  const surface = statePayload.surface;

  const provider = await loadProvider(statePayload.providerId);
  if (!provider || !providerAllowsSurface(provider, surface)) {
    redirectError(res, surface, 'provider_unavailable');
    return;
  }

  try {
    const redirectUri =
      provider.type === 'oidc' ? oidcRedirectUri() : githubRedirectUri();
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = new URLSearchParams(req.originalUrl.split('?')[1] ?? '').toString();

    const identity =
      provider.type === 'oidc'
        ? await exchangeOidcCode(oidcConfig(provider), callbackUrl, {
            state: stateParam,
            codeVerifier: statePayload.codeVerifier,
            nonce: statePayload.nonce,
          })
        : await exchangeGithubCode(
            { clientId: provider.clientId, clientSecret: decrypt(provider.encryptedClientSecret) },
            { code, redirectUri },
          );

    const externalIdentity = {
      providerId: provider._id.toString(),
      issuer: provider.type === 'oidc' ? provider.issuer ?? null : null,
      subject: identity.subject,
      externalUsername: identity.externalUsername,
      displayName: identity.displayName,
      avatarUrl: 'avatarUrl' in identity ? (identity as { avatarUrl?: string | null }).avatarUrl : null,
    };

    if (surface === 'front') {
      const result = await findExternalLogin(externalIdentity);
      if (!result) {
        // 未绑定：不再静默开户，签发一次性 pending 凭证后进入身份选择页。
        const pendingToken = await issuePendingIdentity(externalIdentity);
        res.redirect(
          302,
          `${config.frontendUrl}/login/identity-choice?pending=${encodeURIComponent(pendingToken)}`,
        );
        return;
      }
      const token = signToken(result.user.id);
      const ticket = await issueLoginTicket({ token, user: result.user });
      res.redirect(302, `${config.frontendUrl}/login/callback?ticket=${encodeURIComponent(ticket)}`);
      return;
    }

    if (surface === 'admin') {
      const response = await callAdminApi('/internal/auth/admin-tickets', {
        providerId: externalIdentity.providerId,
        issuer: externalIdentity.issuer,
        subject: externalIdentity.subject,
        profile: {
          externalUsername: externalIdentity.externalUsername,
          displayName: externalIdentity.displayName,
        },
      });
      if (response.status === 403) {
        redirectError(res, surface, 'not_bound');
        return;
      }
      if (response.status !== 200 || typeof response.json.ticket !== 'string') {
        redirectError(res, surface, 'provider_error');
        return;
      }
      res.redirect(
        302,
        `${config.adminFrontendUrl}/login/callback?ticket=${encodeURIComponent(response.json.ticket)}`,
      );
      return;
    }

    // admin-bind
    if (surface === 'admin-bind') {
      if (!statePayload.bindTicket) {
        redirectError(res, surface, 'invalid_request');
        return;
      }
      const bindResponse = await callAdminApi('/internal/auth/admin-bind', {
        bindTicket: statePayload.bindTicket,
        providerId: externalIdentity.providerId,
        issuer: externalIdentity.issuer,
        subject: externalIdentity.subject,
        profile: {
          externalUsername: externalIdentity.externalUsername,
          displayName: externalIdentity.displayName,
        },
      });
      if (bindResponse.status === 200) {
        res.redirect(302, `${config.adminFrontendUrl}/settings/security?bind=success`);
        return;
      }
      if (bindResponse.status === 400 && bindResponse.json.error === 'INVALID_BIND_TICKET') {
        redirectError(res, surface, 'invalid_bind_ticket');
        return;
      }
      if (bindResponse.status === 409) {
        redirectError(res, surface, 'already_bound');
        return;
      }
      redirectError(res, surface, 'provider_error');
      return;
    }

    // front-bind：GETDEL state 已在上面完成，此处消费前台绑定票据并落行。
    if (!statePayload.bindTicket) {
      redirectError(res, surface, 'invalid_request');
      return;
    }
    const frontBind = await consumeFrontBindTicket(statePayload.bindTicket);
    if (!frontBind || frontBind.providerId !== externalIdentity.providerId) {
      redirectError(res, surface, 'invalid_bind_ticket');
      return;
    }
    const targetUser = await User.findById(frontBind.userId).lean();
    if (!targetUser || !targetUser.accountId) {
      redirectError(res, surface, 'invalid_bind_ticket');
      return;
    }
    await bindExternalLoginToUser(
      {
        id: String(targetUser._id),
        accountId: String(targetUser.accountId),
        tenantId: String(targetUser.tenantId ?? targetUser._id),
      },
      externalIdentity,
    );
    res.redirect(302, `${config.frontendUrl}/settings?bind=success`);
  } catch (err) {
    if (err instanceof ExternalLoginError) {
      if (err.code === 'IDENTITY_ALREADY_BOUND') {
        redirectError(res, surface, 'already_bound');
        return;
      }
      if (err.code === 'PROVIDER_ALREADY_BOUND') {
        redirectError(res, surface, 'provider_already_bound');
        return;
      }
      redirectError(res, surface, 'provider_error');
      return;
    }
    if (err instanceof ProvisioningError) {
      redirectError(res, surface, 'provision_failed');
      return;
    }
    if (err instanceof OidcError || err instanceof GithubOauthError) {
      redirectError(res, surface, 'provider_error');
      return;
    }
    logger.warn({ err, providerId: statePayload.providerId, surface }, 'oauth callback failed');
    redirectError(res, surface, 'provider_error');
  }
});
