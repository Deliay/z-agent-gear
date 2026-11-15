import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

const h = vi.hoisted(() => ({
  provider: { findById: vi.fn() },
  decrypt: vi.fn(() => 'secret'),
  buildOidc: vi.fn(),
  exchangeOidc: vi.fn(),
  buildGithub: vi.fn(),
  exchangeGithub: vi.fn(),
  issueState: vi.fn(async () => 'state-1'),
  consumeState: vi.fn(),
  issueTicket: vi.fn(async () => 'ticket-1'),
  issuePending: vi.fn(async () => 'pending-1'),
  consumeFrontBind: vi.fn(),
  findExternalLogin: vi.fn(),
  bindExternalLogin: vi.fn(),
  userFindById: vi.fn(),
  signToken: vi.fn(() => 'jwt-1'),
  config: {
    frontendUrl: 'http://front',
    adminFrontendUrl: 'http://admin',
    adminApiUrl: 'http://admin-api',
    internalApiToken: 'internal',
    publicBaseUrl: 'http://api',
  },
}));

vi.mock('../config/index.js', () => ({ config: h.config }));
vi.mock('../models/auth-provider.js', () => ({
  AuthProvider: { findById: h.provider.findById },
}));
vi.mock('../services/crypto.js', () => ({ decrypt: h.decrypt }));
vi.mock('../services/oidc-client.js', () => ({
  buildOidcAuthorizationUrl: h.buildOidc,
  exchangeOidcCode: h.exchangeOidc,
  OidcError: class OidcError extends Error {},
  oidcRedirectUri: () => 'http://api/api/auth/oauth/callback',
}));
vi.mock('../services/github-oauth.js', () => ({
  buildGithubAuthorizationUrl: h.buildGithub,
  exchangeGithubCode: h.exchangeGithub,
  GithubOauthError: class GithubOauthError extends Error {},
  githubRedirectUri: () => 'http://api/api/auth/oauth/callback',
}));
vi.mock('../services/oauth-flow.js', () => ({
  issueState: h.issueState,
  consumeState: h.consumeState,
  issueLoginTicket: h.issueTicket,
  issuePendingIdentity: h.issuePending,
  consumeFrontBindTicket: h.consumeFrontBind,
  randomToken: () => 'state-raw',
}));
vi.mock('../services/external-login.js', () => ({
  findExternalLogin: h.findExternalLogin,
  bindExternalLoginToUser: h.bindExternalLogin,
  ExternalLoginError: class ExternalLoginError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock('../models/user.js', () => ({
  User: { findById: h.userFindById },
}));
vi.mock('../services/provisioning.js', () => ({
  ProvisioningError: class ProvisioningError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock('../services/auth.js', () => ({ signToken: h.signToken }));

import { authOauthRouter } from './auth-oauth.js';

const PROVIDER_ID = '507f1f77bcf86cd799439011';
const realFetch = globalThis.fetch;

function provider(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => PROVIDER_ID },
    type: 'github_oauth',
    displayName: 'GitHub',
    issuer: null,
    clientId: 'cid',
    encryptedClientSecret: { iv: 'i', ciphertext: 'c', tag: 't' },
    scopes: null,
    enabled: true,
    enableFrontLogin: true,
    enableAdminLogin: true,
    ...overrides,
  };
}

describe('routes/auth-oauth（T-OA-RT）', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.provider.findById.mockReturnValue({ lean: async () => provider() });
    h.issueState.mockResolvedValue('state-1');
    h.issueTicket.mockResolvedValue('ticket-1');
    h.issuePending.mockResolvedValue('pending-1');
    h.buildGithub.mockReturnValue(new URL('http://github/authorize?state=state-1'));

    const app = express();
    app.use('/api', authOauthRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllGlobals();
  });

  async function get(path: string) {
    return realFetch(`${baseUrl}${path}`, { redirect: 'manual' });
  }

  it('T-OA-RT1: 非法 surface → invalid_request', async () => {
    const res = await get(`/api/auth/oauth/${PROVIDER_ID}/authorize?surface=bad`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://front/login?error=invalid_request');
  });

  it('T-OA-RT2: admin-bind 缺 ticket → invalid_request（设置页错误）', async () => {
    const res = await get(`/api/auth/oauth/${PROVIDER_ID}/authorize?surface=admin-bind`);
    expect(res.headers.get('location')).toBe(
      'http://admin/settings/security?bind=error&error=invalid_request',
    );
  });

  it('T-OA-RT3: provider 不存在/未启用/未开 surface → provider_unavailable', async () => {
    h.provider.findById.mockReturnValueOnce({ lean: async () => null });
    let res = await get(`/api/auth/oauth/${PROVIDER_ID}/authorize?surface=front`);
    expect(res.headers.get('location')).toBe('http://front/login?error=provider_unavailable');

    h.provider.findById.mockReturnValueOnce({ lean: async () => provider({ enabled: false }) });
    res = await get(`/api/auth/oauth/${PROVIDER_ID}/authorize?surface=front`);
    expect(res.headers.get('location')).toBe('http://front/login?error=provider_unavailable');

    h.provider.findById.mockReturnValueOnce({
      lean: async () => provider({ enableAdminLogin: false }),
    });
    res = await get(`/api/auth/oauth/${PROVIDER_ID}/authorize?surface=admin`);
    expect(res.headers.get('location')).toBe('http://admin/login?error=provider_unavailable');
  });

  it('T-OA-RT4: GitHub authorize 写 state 并 302 授权页', async () => {
    const res = await get(`/api/auth/oauth/${PROVIDER_ID}/authorize?surface=front`);
    expect(res.headers.get('location')).toBe('http://github/authorize?state=state-1');
    expect(h.issueState).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      surface: 'front',
    });
  });

  it('T-OA-RT5: OIDC authorize 写入 PKCE/nonce 后跳转', async () => {
    h.provider.findById.mockReturnValue({
      lean: async () =>
        provider({
          type: 'oidc',
          issuer: 'http://idp',
          scopes: 'openid',
        }),
    });
    h.buildOidc.mockResolvedValue({
      url: new URL('http://idp/authorize'),
      codeVerifier: 'v1',
      nonce: 'n1',
      pkce: true,
    });

    const res = await get(`/api/auth/oauth/${PROVIDER_ID}/authorize?surface=front`);
    expect(res.headers.get('location')).toBe('http://idp/authorize');
    expect(h.issueState).toHaveBeenCalledWith(
      expect.objectContaining({ codeVerifier: 'v1', nonce: 'n1' }),
      'state-raw',
    );
  });

  it('T-OA-RT6: 授权取消 → access_denied', async () => {
    h.consumeState.mockResolvedValue({ providerId: PROVIDER_ID, surface: 'front' });
    const res = await get('/api/auth/oauth/callback?error=access_denied&state=s1');
    expect(res.headers.get('location')).toBe('http://front/login?error=access_denied');
  });

  it('T-OA-RT7: state 无效/重放 → invalid_state', async () => {
    h.consumeState.mockResolvedValue(null);
    const res = await get('/api/auth/oauth/callback?code=c&state=bad');
    expect(res.headers.get('location')).toBe('http://front/login?error=invalid_state');
  });

  it('T-OA-RT8: 已绑定前台登录 → 302 /login/callback?ticket=', async () => {
    h.consumeState.mockResolvedValue({ providerId: PROVIDER_ID, surface: 'front' });
    h.exchangeGithub.mockResolvedValue({
      subject: '1001',
      externalUsername: 'octo',
      displayName: 'Octo',
      avatarUrl: null,
    });
    h.findExternalLogin.mockResolvedValue({
      user: { id: 'u1', name: 'octo', tenantId: 'u1', createdAt: '2026-01-01' },
      account: { id: 'a1', username: 'octo' },
      created: false,
    });

    const res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe('http://front/login/callback?ticket=ticket-1');
    expect(h.signToken).toHaveBeenCalledWith('u1');
  });

  it('T-OA-RT-FB1: 前台未绑定 → 302 身份选择页并写 pending', async () => {
    h.consumeState.mockResolvedValue({ providerId: PROVIDER_ID, surface: 'front' });
    h.exchangeGithub.mockResolvedValue({
      subject: '1001',
      externalUsername: 'octo',
      displayName: 'Octo',
      avatarUrl: null,
    });
    h.findExternalLogin.mockResolvedValue(null);

    const res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe(
      'http://front/login/identity-choice?pending=pending-1',
    );
    expect(h.issuePending).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: PROVIDER_ID, subject: '1001' }),
    );
    expect(h.signToken).not.toHaveBeenCalled();
  });

  it('T-OA-RT9: 后台未绑定 → not_bound', async () => {
    h.consumeState.mockResolvedValue({ providerId: PROVIDER_ID, surface: 'admin' });
    h.exchangeGithub.mockResolvedValue({
      subject: '1001',
      externalUsername: 'octo',
      displayName: 'Octo',
      avatarUrl: null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'NOT_BOUND' }), { status: 403 })));

    const res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe('http://admin/login?error=not_bound');
  });

  it('T-OA-RT10: 后台绑定成功 → 设置页 bind=success', async () => {
    h.consumeState.mockResolvedValue({
      providerId: PROVIDER_ID,
      surface: 'admin-bind',
      bindTicket: 'bind-1',
    });
    h.exchangeGithub.mockResolvedValue({
      subject: '1001',
      externalUsername: 'octo',
      displayName: 'Octo',
      avatarUrl: null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe('http://admin/settings/security?bind=success');
  });

  it('T-OA-RT11: 绑定票据无效 → invalid_bind_ticket；已绑定 → already_bound', async () => {
    h.consumeState.mockResolvedValue({
      providerId: PROVIDER_ID,
      surface: 'admin-bind',
      bindTicket: 'bind-1',
    });
    h.exchangeGithub.mockResolvedValue({
      subject: '1001',
      externalUsername: 'octo',
      displayName: 'Octo',
      avatarUrl: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'INVALID_BIND_TICKET' }), { status: 400 })),
    );
    let res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe(
      'http://admin/settings/security?bind=error&error=invalid_bind_ticket',
    );

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'ALREADY_BOUND' }), { status: 409 })));
    res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe(
      'http://admin/settings/security?bind=error&error=already_bound',
    );
  });

  it('T-OA-RT-FB2: front-bind authorize 缺 ticket → 设置页 invalid_request', async () => {
    const res = await get(`/api/auth/oauth/${PROVIDER_ID}/authorize?surface=front-bind`);
    expect(res.headers.get('location')).toBe(
      'http://front/settings?bind=error&error=invalid_request',
    );
  });

  it('T-OA-RT-FB3: front-bind authorize 写 state（含票据）并跳授权页', async () => {
    const res = await get(
      `/api/auth/oauth/${PROVIDER_ID}/authorize?surface=front-bind&ticket=fb-1`,
    );
    expect(res.headers.get('location')).toBe('http://github/authorize?state=state-1');
    expect(h.issueState).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      surface: 'front-bind',
      bindTicket: 'fb-1',
    });
  });

  it('T-OA-RT-FB4: front-bind 回调成功落绑定并 302 设置页 bind=success', async () => {
    h.consumeState.mockResolvedValue({
      providerId: PROVIDER_ID,
      surface: 'front-bind',
      bindTicket: 'fb-1',
    });
    h.exchangeGithub.mockResolvedValue({
      subject: '1001',
      externalUsername: 'octo',
      displayName: 'Octo',
      avatarUrl: null,
    });
    h.consumeFrontBind.mockResolvedValue({ userId: 'u1', providerId: PROVIDER_ID });
    h.userFindById.mockReturnValue({
      lean: async () => ({ _id: 'u1', accountId: 'a1', tenantId: 'u1' }),
    });
    h.bindExternalLogin.mockResolvedValue({ id: 'el1' });

    const res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe('http://front/settings?bind=success');
    expect(h.bindExternalLogin).toHaveBeenCalledWith(
      { id: 'u1', accountId: 'a1', tenantId: 'u1' },
      expect.objectContaining({ subject: '1001' }),
    );
  });

  it('T-OA-RT-FB5: 绑定票据过期/与 provider 不匹配 → invalid_bind_ticket', async () => {
    h.consumeState.mockResolvedValue({
      providerId: PROVIDER_ID,
      surface: 'front-bind',
      bindTicket: 'fb-1',
    });
    h.exchangeGithub.mockResolvedValue({
      subject: '1001',
      externalUsername: 'octo',
      displayName: 'Octo',
      avatarUrl: null,
    });
    h.consumeFrontBind.mockResolvedValue(null);
    let res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe(
      'http://front/settings?bind=error&error=invalid_bind_ticket',
    );

    h.consumeFrontBind.mockResolvedValue({ userId: 'u1', providerId: 'other' });
    res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe(
      'http://front/settings?bind=error&error=invalid_bind_ticket',
    );
  });

  it('T-OA-RT-FB6: front-bind 身份占用 / 同账户重复绑定 → 稳定错误码', async () => {
    h.consumeState.mockResolvedValue({
      providerId: PROVIDER_ID,
      surface: 'front-bind',
      bindTicket: 'fb-1',
    });
    h.exchangeGithub.mockResolvedValue({
      subject: '1001',
      externalUsername: 'octo',
      displayName: 'Octo',
      avatarUrl: null,
    });
    h.consumeFrontBind.mockResolvedValue({ userId: 'u1', providerId: PROVIDER_ID });
    h.userFindById.mockReturnValue({
      lean: async () => ({ _id: 'u1', accountId: 'a1', tenantId: 'u1' }),
    });
    const ExternalLoginError = await import('../services/external-login.js').then(
      (m) => m.ExternalLoginError,
    );

    h.bindExternalLogin.mockRejectedValueOnce(new ExternalLoginError('IDENTITY_ALREADY_BOUND'));
    let res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe(
      'http://front/settings?bind=error&error=already_bound',
    );

    h.bindExternalLogin.mockRejectedValueOnce(new ExternalLoginError('PROVIDER_ALREADY_BOUND'));
    res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe(
      'http://front/settings?bind=error&error=provider_already_bound',
    );
  });

  it('T-OA-RT-FB7: front-bind 目标用户缺失 → invalid_bind_ticket', async () => {
    h.consumeState.mockResolvedValue({
      providerId: PROVIDER_ID,
      surface: 'front-bind',
      bindTicket: 'fb-1',
    });
    h.exchangeGithub.mockResolvedValue({
      subject: '1001',
      externalUsername: 'octo',
      displayName: 'Octo',
      avatarUrl: null,
    });
    h.consumeFrontBind.mockResolvedValue({ userId: 'u1', providerId: PROVIDER_ID });
    h.userFindById.mockReturnValue({ lean: async () => null });

    const res = await get('/api/auth/oauth/callback?code=c&state=s1');
    expect(res.headers.get('location')).toBe(
      'http://front/settings?bind=error&error=invalid_bind_ticket',
    );
  });
});
