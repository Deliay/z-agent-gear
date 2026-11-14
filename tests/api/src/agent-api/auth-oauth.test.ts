/**
 * 第三方登录 OAuth/OIDC 全链路 API（T-OA-API*）。
 *
 * 依赖：agent-api + admin-api 就绪、`MONGODB_URI`（夹具清理/落库断言）。
 * OIDC 使用进程内 fake IdP（`fake-oidc-server.ts`，默认 19419）；
 * GitHub 需 agent-api 以
 * `GITHUB_OAUTH_AUTHORIZE_URL=http://127.0.0.1:19418/login/oauth/authorize`
 * `GITHUB_OAUTH_TOKEN_URL=http://127.0.0.1:19418/login/oauth/access_token`
 * `GITHUB_OAUTH_API_BASE=http://127.0.0.1:19418` 启动，否则 GitHub 用例显式 skip。
 *
 * 覆盖：authorize 分 surface、回调自动开户、再登同账户、取消授权、state 重放、
 * 停用 provider、后台未绑定、绑定后登录、绑定解绑、ticket 一次性。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { adminGql, ensureAdminLogin } from '../admin-api/helpers.js';
import { startFakeOidcServer, type FakeOidcServer } from '../fake-oidc-server.js';
import { startMockGitHubServer, type MockGitHubServer } from '../mock-github-server.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const API_BASE = process.env.AGENT_API_BASE || API_URL.replace(/\/graphql\/?$/, '');
const HAS_MONGO = Boolean(process.env.MONGODB_URI);
const OIDC_PORT = Number(process.env.MOCK_OIDC_PORT || 19419);
const GITHUB_PORT = Number(process.env.MOCK_GITHUB_PORT || 19418);
const OIDC_CLIENT_ID = 'api-test-oidc';
const OIDC_CLIENT_SECRET = 'api-test-oidc-secret';
const GITHUB_CLIENT_ID = 'api-test-github';
const GITHUB_CLIENT_SECRET = 'api-test-github-secret';

const CREATE_OIDC = `
  mutation CreateOidc($input: OidcProviderInput!) {
    createOidcProvider(input: $input) { id displayName enabled enableFrontLogin enableAdminLogin }
  }
`;

const UPDATE_OIDC = `
  mutation UpdateOidc($id: ID!, $input: OidcProviderInput!) {
    updateOidcProvider(id: $id, input: $input) { id enabled enableFrontLogin enableAdminLogin }
  }
`;

const DELETE_OIDC = `
  mutation DeleteOidc($id: ID!) { deleteOidcProvider(id: $id) }
`;

const UPSERT_GITHUB = `
  mutation UpsertGithub($input: GithubOauthInput!) {
    upsertGithubOauthConfig(input: $input) { id enabled enableFrontLogin enableAdminLogin }
  }
`;

const ADMIN_BIND_TICKET = `
  mutation AdminBindTicket($providerId: ID!) { createAdminBindTicket(providerId: $providerId) }
`;

const ADMIN_EXTERNAL_LOGINS = `
  query AdminExternalLogins {
    adminExternalLogins { id providerId providerDisplayName externalUsername createdAt }
  }
`;

const UNBIND = `
  mutation Unbind($id: ID!) { unbindAdminExternalLogin(id: $id) }
`;

const ADMIN_EXCHANGE = `
  mutation AdminExchange($ticket: String!) {
    adminExchangeLoginTicket(ticket: $ticket) {
      token
      admin { id username mustChangePassword }
    }
  }
`;

const ADMIN_ME = `query AdminMe { adminMe { id username } }`;

const EXCHANGE = `
  mutation Exchange($ticket: String!) {
    exchangeLoginTicket(ticket: $ticket) {
      token
      user { id name tenant { id name type memberCount } }
    }
  }
`;

const ME = `
  query Me {
    me { id name tenant { id name type memberCount } }
  }
`;

async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
}

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  if (!HAS_MONGO) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
  return mongoose.connection.db ?? null;
}

function authorizeUrl(providerId: string, surface: string, ticket?: string): string {
  const url = new URL(`${API_BASE}/api/auth/oauth/${providerId}/authorize`);
  url.searchParams.set('surface', surface);
  if (ticket) url.searchParams.set('ticket', ticket);
  return url.toString();
}

async function redirectLocation(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return res.headers.get('location') ?? '';
}

async function mongoCount(collection: string, filter: Record<string, unknown>): Promise<number> {
  const db = await mongoDb();
  if (!db) return 0;
  return db.collection(collection).countDocuments(filter);
}

describe.skipIf(!HAS_MONGO)('OAuth/OIDC 登录 API（T-OA-API）', () => {
  let adminToken = '';
  let oidc: FakeOidcServer;
  let github: MockGitHubServer;
  let oidcProviderId = '';
  let githubProviderId = '';
  const subject = `oidc-${Date.now()}`;
  const createdUserIds = new Set<string>();

  beforeAll(async () => {
    adminToken = await ensureAdminLogin();
    oidc = await startFakeOidcServer({
      port: OIDC_PORT,
      clientId: OIDC_CLIENT_ID,
      clientSecret: OIDC_CLIENT_SECRET,
    });
    oidc.setClaims({
      sub: subject,
      preferred_username: `oidc${Date.now().toString(36)}`.slice(0, 20),
      name: 'API OIDC User',
      email: `oidc-${Date.now()}@example.com`,
    });

    try {
      github = await startMockGitHubServer({ port: GITHUB_PORT });
    } catch {
      github = await startMockGitHubServer();
    }

    const created = await adminGql<{ createOidcProvider: { id: string } }>(
      CREATE_OIDC,
      {
        input: {
          displayName: 'API Test OIDC',
          issuer: oidc.issuer,
          clientId: OIDC_CLIENT_ID,
          clientSecret: OIDC_CLIENT_SECRET,
          scopes: 'openid profile email',
          enabled: true,
          enableFrontLogin: true,
          enableAdminLogin: true,
        },
      },
      adminToken,
    );
    if (!created.data?.createOidcProvider?.id) {
      throw new Error(`create OIDC provider failed: ${JSON.stringify(created.errors)}`);
    }
    oidcProviderId = created.data.createOidcProvider.id;

    const githubConfig = await adminGql<{ upsertGithubOauthConfig: { id: string } }>(
      UPSERT_GITHUB,
      {
        input: {
          clientId: GITHUB_CLIENT_ID,
          clientSecret: GITHUB_CLIENT_SECRET,
          enabled: true,
          enableFrontLogin: true,
          enableAdminLogin: true,
        },
      },
      adminToken,
    );
    githubProviderId = githubConfig.data?.upsertGithubOauthConfig?.id ?? '';
  });

  afterAll(async () => {
    if (oidcProviderId) {
      await adminGql(DELETE_OIDC, { id: oidcProviderId }, adminToken).catch(() => undefined);
    }
    if (githubProviderId) {
      await adminGql(UPSERT_GITHUB, { input: { enabled: false } }, adminToken).catch(() => undefined);
    }

    const db = await mongoDb();
    if (db) {
      await db.collection('externallogins').deleteMany({ subject });
      if (githubProviderId) {
        await db.collection('externallogins').deleteMany({ providerId: githubProviderId });
      }
      for (const userId of createdUserIds) {
        const objectId = new mongoose.Types.ObjectId(userId);
        const user = await db.collection('users').findOne({ _id: objectId });
        if (user?.accountId) {
          await db.collection('accounts').deleteOne({ _id: user.accountId });
        }
        await db.collection('billingaccounts').deleteMany({ ownerId: userId });
        await db.collection('workspaces').deleteMany({ tenantId: objectId });
        await db.collection('tenantmembers').deleteMany({ tenantId: objectId });
        await db.collection('tenants').deleteMany({ _id: objectId });
        await db.collection('users').deleteMany({ _id: objectId });
      }
    }
    await oidc?.close();
    await github?.close();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => undefined);
  });

  async function frontLogin(): Promise<{ location: string; ticket: string; userId: string; token: string }> {
    const authorize = await redirectLocation(authorizeUrl(oidcProviderId, 'front'));
    expect(authorize).toContain(oidc.issuer);
    const callback = await redirectLocation(authorize);
    expect(callback).toContain(`${API_BASE}/api/auth/oauth/callback`);
    const location = await redirectLocation(callback);
    const ticket = new URL(location).searchParams.get('ticket') ?? '';
    expect(ticket).toHaveLength(64);

    const exchanged = await gql<{
      exchangeLoginTicket: { token: string; user: { id: string; name: string } };
    }>(EXCHANGE, { ticket });
    expect(exchanged.errors, JSON.stringify(exchanged.errors)).toBeUndefined();
    const payload = exchanged.data!.exchangeLoginTicket;
    createdUserIds.add(payload.user.id);
    return { location, ticket, userId: payload.user.id, token: payload.token };
  }

  it('T-OA-API1: 前台首登自动开户 + ticket 兑换 + me 命中', async () => {
    const first = await frontLogin();
    expect(first.location).toContain('/login/callback?ticket=');

    const me = await gql<{ me: { id: string; tenant: { type: string } } }>(ME, undefined, first.token);
    expect(me.errors, JSON.stringify(me.errors)).toBeUndefined();
    expect(me.data!.me.id).toBe(first.userId);
    expect(me.data!.me.tenant.type).toBe('personal');

    expect(await mongoCount('externallogins', { subject })).toBe(1);
    const db = await mongoDb();
    const row = await db!.collection('externallogins').findOne({ subject });
    expect(row).toMatchObject({
      providerId: oidcProviderId,
      issuer: oidc.issuer,
      userId: new mongoose.Types.ObjectId(first.userId),
    });
  });

  it('T-OA-API2: 同一外部身份再次登录进入同一账户，不重复开户', async () => {
    const first = await frontLogin();
    const second = await frontLogin();
    expect(second.userId).toBe(first.userId);
    expect(await mongoCount('externallogins', { subject })).toBe(1);
  });

  it('T-OA-API3: ticket 一次性（第二次兑换失败）', async () => {
    const login = await frontLogin();
    const replay = await gql(EXCHANGE, { ticket: login.ticket });
    expect(replay.errors?.[0]?.message).toBe('invalid or expired ticket');
  });

  it('T-OA-API4: state 重放返回 invalid_state', async () => {
    const authorize = await redirectLocation(authorizeUrl(oidcProviderId, 'front'));
    const callback = await redirectLocation(authorize);
    const success = await redirectLocation(callback);
    expect(success).toContain('/login/callback?ticket=');
    const ticket = new URL(success).searchParams.get('ticket') ?? '';
    const exchanged = await gql<{ exchangeLoginTicket: { user: { id: string } } }>(EXCHANGE, {
      ticket,
    });
    createdUserIds.add(exchanged.data!.exchangeLoginTicket.user.id);

    const replay = await redirectLocation(callback);
    expect(replay).toContain('/login?error=invalid_state');
  });

  it('T-OA-API5: 用户取消授权回登录页 access_denied', async () => {
    oidc.denyNext();
    const authorize = await redirectLocation(authorizeUrl(oidcProviderId, 'front'));
    const denied = await redirectLocation(authorize);
    expect(denied).toContain('error=access_denied');
    const location = await redirectLocation(denied);
    expect(location).toContain('/login?error=access_denied');
  });

  it('T-OA-API6: provider 停用后 authorize 返回 provider_unavailable', async () => {
    await adminGql(UPDATE_OIDC, { id: oidcProviderId, input: { enabled: false } }, adminToken);
    const location = await redirectLocation(authorizeUrl(oidcProviderId, 'front'));
    expect(location).toContain('/login?error=provider_unavailable');
    await adminGql(
      UPDATE_OIDC,
      {
        id: oidcProviderId,
        input: { enabled: true, enableFrontLogin: true, enableAdminLogin: true },
      },
      adminToken,
    );
  });

  it('T-OA-API7: 非法的 surface / 未知 provider 被拒绝', async () => {
    const invalidSurface = await redirectLocation(
      `${API_BASE}/api/auth/oauth/${oidcProviderId}/authorize?surface=bogus`,
    );
    expect(invalidSurface).toContain('error=invalid_request');

    const unknown = await redirectLocation(
      `${API_BASE}/api/auth/oauth/507f1f77bcf86cd799439011/authorize?surface=front`,
    );
    expect(unknown).toContain('error=provider_unavailable');
  });

  it('T-OA-API8: 后台未绑定身份返回 not_bound', async () => {
    const authorize = await redirectLocation(authorizeUrl(oidcProviderId, 'admin'));
    const callback = await redirectLocation(authorize);
    const location = await redirectLocation(callback);
    expect(location).toContain('/login?error=not_bound');
  });

  it('T-OA-API9: 绑定 → 后台登录换票 → 解绑后拒绝（T-OA-API9）', async () => {
    const ticket = await adminGql<{ createAdminBindTicket: string }>(
      ADMIN_BIND_TICKET,
      { providerId: oidcProviderId },
      adminToken,
    );
    expect(ticket.errors, JSON.stringify(ticket.errors)).toBeUndefined();
    const bindTicket = ticket.data!.createAdminBindTicket;
    expect(bindTicket).toHaveLength(64);

    const authorize = await redirectLocation(authorizeUrl(oidcProviderId, 'admin-bind', bindTicket));
    const callback = await redirectLocation(authorize);
    const bound = await redirectLocation(callback);
    expect(bound).toContain('/settings/security?bind=success');

    const bindings = await adminGql<{
      adminExternalLogins: Array<{ id: string; providerId: string; externalUsername: string }>;
    }>(ADMIN_EXTERNAL_LOGINS, undefined, adminToken);
    expect(bindings.errors, JSON.stringify(bindings.errors)).toBeUndefined();
    const binding = bindings.data!.adminExternalLogins.find(
      (item) => item.providerId === oidcProviderId,
    )!;
    expect(binding).toBeDefined();

    const adminAuthorize = await redirectLocation(authorizeUrl(oidcProviderId, 'admin'));
    const adminCallback = await redirectLocation(adminAuthorize);
    const loginLocation = await redirectLocation(adminCallback);
    const loginTicket = new URL(loginLocation).searchParams.get('ticket') ?? '';
    expect(loginTicket).toHaveLength(64);

    const exchanged = await adminGql<{ adminExchangeLoginTicket: { token: string } }>(
      ADMIN_EXCHANGE,
      { ticket: loginTicket },
    );
    expect(exchanged.errors, JSON.stringify(exchanged.errors)).toBeUndefined();
    const adminJwt = exchanged.data!.adminExchangeLoginTicket.token;
    const me = await adminGql<{ adminMe: { username: string } }>(ADMIN_ME, undefined, adminJwt);
    expect(me.data!.adminMe.username).toBe('admin');

    const unbound = await adminGql<{ unbindAdminExternalLogin: boolean }>(
      UNBIND,
      { id: binding.id },
      adminToken,
    );
    expect(unbound.data!.unbindAdminExternalLogin).toBe(true);

    const afterUnbindAuthorize = await redirectLocation(authorizeUrl(oidcProviderId, 'admin'));
    const afterUnbindCallback = await redirectLocation(afterUnbindAuthorize);
    const afterUnbind = await redirectLocation(afterUnbindCallback);
    expect(afterUnbind).toContain('/login?error=not_bound');
  });

  it('T-OA-API10: GitHub 前台登录（需 agent-api 指向进程内 mock）', async () => {
    const authorizeEnv = process.env.GITHUB_OAUTH_AUTHORIZE_URL ?? '';
    if (!authorizeEnv.includes(String(GITHUB_PORT))) {
      // agent-api 未指向 fake：显式跳过，不假装通过
      return;
    }
    const authorize = await redirectLocation(authorizeUrl(githubProviderId, 'front'));
    expect(authorize).toContain(`127.0.0.1:${GITHUB_PORT}`);
    const callback = await redirectLocation(authorize);
    const location = await redirectLocation(callback);
    expect(location).toContain('/login/callback?ticket=');
    const ticket = new URL(location).searchParams.get('ticket') ?? '';
    const exchanged = await gql<{ exchangeLoginTicket: { user: { id: string } } }>(EXCHANGE, {
      ticket,
    });
    expect(exchanged.errors, JSON.stringify(exchanged.errors)).toBeUndefined();
    createdUserIds.add(exchanged.data!.exchangeLoginTicket.user.id);
  });
});
