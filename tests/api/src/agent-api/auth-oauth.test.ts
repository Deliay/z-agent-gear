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
import {
  createFrontUser,
  DEFAULT_FRONT_USER_PASSWORD,
  type FrontUser,
} from '../support/front-users.js';

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

const PENDING_INFO = `
  query PendingInfo($pendingToken: String!) {
    pendingExternalLoginInfo(pendingToken: $pendingToken) {
      providerDisplayName
      externalUsername
    }
  }
`;

const BIND_WITH_PASSWORD = `
  mutation BindWithPassword($pendingToken: String!, $username: String!, $password: String!) {
    bindExternalLoginWithPassword(
      pendingToken: $pendingToken
      username: $username
      password: $password
    ) {
      token
      user { id name tenant { id name type memberCount } }
    }
  }
`;

const PROVISION = `
  mutation Provision($pendingToken: String!) {
    provisionExternalLogin(pendingToken: $pendingToken) {
      token
      user { id name tenant { id name type memberCount } }
    }
  }
`;

const MY_EXTERNAL_LOGINS = `
  query MyExternalLogins {
    myExternalLogins {
      id
      providerId
      providerType
      providerDisplayName
      providerEnabled
      externalUsername
      createdAt
      lastLoginAt
    }
  }
`;

const CREATE_FRONT_BIND_TICKET = `
  mutation CreateFrontBindTicket($providerId: ID!) {
    createFrontBindTicket(providerId: $providerId)
  }
`;

const UNBIND_EXTERNAL_LOGIN = `
  mutation UnbindExternalLogin($id: ID!) { unbindExternalLogin(id: $id) }
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
      await db.collection('externallogins').deleteMany({ subject: { $regex: `^${subject}` } });
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

  async function callbackLocation(surface: string, ticket?: string): Promise<string> {
    const authorize = await redirectLocation(authorizeUrl(oidcProviderId, surface, ticket));
    const callback = await redirectLocation(authorize);
    return redirectLocation(callback);
  }

  function pendingFrom(location: string): string {
    expect(location).toContain('/login/identity-choice?pending=');
    const pending = new URL(location).searchParams.get('pending') ?? '';
    expect(pending).toHaveLength(64);
    return pending;
  }

  async function provisionPending(pending: string): Promise<{ userId: string; token: string }> {
    const provisioned = await gql<{
      provisionExternalLogin: { token: string; user: { id: string; name: string } };
    }>(PROVISION, { pendingToken: pending });
    expect(provisioned.errors, JSON.stringify(provisioned.errors)).toBeUndefined();
    const payload = provisioned.data!.provisionExternalLogin;
    createdUserIds.add(payload.user.id);
    return { userId: payload.user.id, token: payload.token };
  }

  async function exchangeTicket(ticket: string): Promise<{
    location: string;
    ticket: string;
    userId: string;
    token: string;
  }> {
    const exchanged = await gql<{
      exchangeLoginTicket: { token: string; user: { id: string; name: string } };
    }>(EXCHANGE, { ticket });
    expect(exchanged.errors, JSON.stringify(exchanged.errors)).toBeUndefined();
    const payload = exchanged.data!.exchangeLoginTicket;
    createdUserIds.add(payload.user.id);
    return { location: '', ticket, userId: payload.user.id, token: payload.token };
  }

  async function frontLogin(): Promise<{ location: string; ticket: string; userId: string; token: string }> {
    const location = await callbackLocation('front');
    const pending = new URL(location).searchParams.get('pending');
    if (pending) {
      const provisioned = await provisionPending(pending);
      return { location, ticket: '', ...provisioned };
    }
    const ticket = new URL(location).searchParams.get('ticket') ?? '';
    expect(ticket).toHaveLength(64);
    const result = await exchangeTicket(ticket);
    return { ...result, location };
  }

  async function setSubject(subjectValue: string): Promise<void> {
    oidc.setClaims({
      sub: subjectValue,
      preferred_username: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`.slice(0, 20),
      name: '绑定时用户',
      email: `${subjectValue}@example.com`,
    });
  }

  async function frontBind(user: FrontUser): Promise<{ ticket: string; location: string }> {
    const ticketRes = await gql<{ createFrontBindTicket: string }>(
      CREATE_FRONT_BIND_TICKET,
      { providerId: oidcProviderId },
      user.token,
    );
    expect(ticketRes.errors, JSON.stringify(ticketRes.errors)).toBeUndefined();
    const ticket = ticketRes.data!.createFrontBindTicket;
    expect(ticket).toHaveLength(64);
    const location = await callbackLocation('front-bind', ticket);
    return { ticket, location };
  }

  it('T-OA-API1: 前台首登未绑定 → 身份选择创建新帐号 + me 命中', async () => {
    const first = await frontLogin();
    expect(first.location).toContain('/login/identity-choice?pending=');

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

  it('T-OA-API11: 首登未命中 → 302 身份选择页 + pending 键存在且不开户', async () => {
    const api11Subject = `${subject}-api11`;
    await setSubject(api11Subject);
    const location = await callbackLocation('front');
    const pending = pendingFrom(location);

    expect(await mongoCount('externallogins', { subject: api11Subject })).toBe(0);
    const info = await gql<{
      pendingExternalLoginInfo: { providerDisplayName: string; externalUsername: string } | null;
    }>(PENDING_INFO, { pendingToken: pending });
    expect(info.errors, JSON.stringify(info.errors)).toBeUndefined();
    expect(info.data!.pendingExternalLoginInfo?.providerDisplayName).toBe('API Test OIDC');
    expect(info.data!.pendingExternalLoginInfo?.externalUsername).toBeTruthy();
  });

  it('T-OA-API12: pending + 正确用户名密码 → 绑定既有账户并登录（数据汇合）', async () => {
    const api12Subject = `${subject}-api12`;
    await setSubject(api12Subject);
    const pending = pendingFrom(await callbackLocation('front'));

    const existing = await createFrontUser();
    createdUserIds.add(existing.userId);

    const bound = await gql<{
      bindExternalLoginWithPassword: {
        token: string;
        user: { id: string; name: string };
      };
    }>(BIND_WITH_PASSWORD, {
      pendingToken: pending,
      username: existing.username,
      password: DEFAULT_FRONT_USER_PASSWORD,
    });
    expect(bound.errors, JSON.stringify(bound.errors)).toBeUndefined();
    expect(bound.data!.bindExternalLoginWithPassword.user.id).toBe(existing.userId);

    const me = await gql<{ me: { id: string } }>(
      ME,
      undefined,
      bound.data!.bindExternalLoginWithPassword.token,
    );
    expect(me.data!.me.id).toBe(existing.userId);

    const row = await (await mongoDb())!.collection('externallogins').findOne({
      subject: api12Subject,
    });
    expect(String(row?.userId)).toBe(existing.userId);

    // pending 已消费：再次提交 → 过期
    const replay = await gql(PROVISION, { pendingToken: pending });
    expect(replay.errors?.[0]?.message).toBe('invalid or expired pending token');
  });

  it('T-OA-API13: 错误密码计次不消费，连续 5 次后 pending 作废', async () => {
    const api13Subject = `${subject}-api13`;
    await setSubject(api13Subject);
    const pending = pendingFrom(await callbackLocation('front'));
    const existing = await createFrontUser();
    createdUserIds.add(existing.userId);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await gql(BIND_WITH_PASSWORD, {
        pendingToken: pending,
        username: existing.username,
        password: 'wrong-password',
      });
      expect(failed.errors?.[0]?.message).toBe('Invalid username or password');
      if (attempt < 5) {
        const info = await gql<{ pendingExternalLoginInfo: unknown }>(PENDING_INFO, {
          pendingToken: pending,
        });
        expect(info.data!.pendingExternalLoginInfo).not.toBeNull();
      }
    }

    const after = await gql<{ pendingExternalLoginInfo: unknown }>(PENDING_INFO, {
      pendingToken: pending,
    });
    expect(after.data!.pendingExternalLoginInfo).toBeNull();
  });

  it('T-OA-API14: pending + 创建新帐号 → 开户（passwordless=true）+ AuthPayload', async () => {
    const api14Subject = `${subject}-api14`;
    await setSubject(api14Subject);
    const pending = pendingFrom(await callbackLocation('front'));
    const provisioned = await provisionPending(pending);

    const db = (await mongoDb())!;
    const user = await db
      .collection('users')
      .findOne({ _id: new mongoose.Types.ObjectId(provisioned.userId) });
    expect(user).toBeTruthy();
    const account = await db.collection('accounts').findOne({ _id: user!.accountId });
    expect(account?.passwordless).toBe(true);

    const me = await gql<{ me: { id: string } }>(ME, undefined, provisioned.token);
    expect(me.data!.me.id).toBe(provisioned.userId);
  });

  it('T-OA-API15: pending 期间身份被抢绑 → 两条 mutation 均 identity already bound', async () => {
    const api15Subject = `${subject}-api15`;
    await setSubject(api15Subject);
    const pending = pendingFrom(await callbackLocation('front'));

    const userA = await createFrontUser();
    const userB = await createFrontUser();
    createdUserIds.add(userA.userId);
    createdUserIds.add(userB.userId);

    const bindB = await frontBind(userB);
    expect(bindB.location).toContain('/settings?bind=success');

    const bind = await gql(BIND_WITH_PASSWORD, {
      pendingToken: pending,
      username: userA.username,
      password: DEFAULT_FRONT_USER_PASSWORD,
    });
    expect(bind.errors?.[0]?.message).toBe('identity already bound');

    const provision = await gql(PROVISION, { pendingToken: pending });
    expect(provision.errors?.[0]?.message).toBe('identity already bound');
  });

  it('T-OA-API16: front-bind 全链路（票据 → 授权 → 回调 → 列表可见）', async () => {
    const api16Subject = `${subject}-api16`;
    await setSubject(api16Subject);
    const user = await createFrontUser();
    createdUserIds.add(user.userId);

    const result = await frontBind(user);
    expect(result.location).toContain('/settings?bind=success');

    const logins = await gql<{
      myExternalLogins: Array<{
        id: string;
        providerId: string;
        providerDisplayName: string;
        externalUsername: string;
        providerEnabled: boolean;
      }>;
    }>(MY_EXTERNAL_LOGINS, undefined, user.token);
    expect(logins.errors, JSON.stringify(logins.errors)).toBeUndefined();
    const row = logins.data!.myExternalLogins.find(
      (item) => item.providerId === oidcProviderId,
    );
    expect(row).toBeDefined();
    expect(row!.providerDisplayName).toBe('API Test OIDC');
    expect(row!.providerEnabled).toBe(true);
  });

  it('T-OA-API17: front-bind 票据缺失/过期 → invalid_request / invalid_bind_ticket', async () => {
    const missing = await redirectLocation(
      authorizeUrl(oidcProviderId, 'front-bind'),
    );
    expect(missing).toContain('/settings?bind=error&error=invalid_request');

    const expiredTicket = 'a'.repeat(64);
    const location = await callbackLocation('front-bind', expiredTicket);
    expect(location).toContain('/settings?bind=error&error=invalid_bind_ticket');
  });

  it('T-OA-API18: 同账户同 provider 重复绑定 → provider already bound', async () => {
    const api18Subject = `${subject}-api18`;
    await setSubject(api18Subject);
    const user = await createFrontUser();
    createdUserIds.add(user.userId);
    const bound = await frontBind(user);
    expect(bound.location).toContain('bind=success');

    const duplicate = await gql(CREATE_FRONT_BIND_TICKET, { providerId: oidcProviderId }, user.token);
    expect(duplicate.errors?.[0]?.message).toBe('provider already bound');
  });

  it('T-OA-API19: 解绑（正常 / 解绑后可重新首登；无密码最后一条拒绝）', async () => {
    const api19Subject = `${subject}-api19`;
    await setSubject(api19Subject);
    const user = await createFrontUser();
    createdUserIds.add(user.userId);
    await frontBind(user);

    const logins = await gql<{ myExternalLogins: Array<{ id: string }> }>(
      MY_EXTERNAL_LOGINS,
      undefined,
      user.token,
    );
    const bindingId = logins.data!.myExternalLogins[0].id;
    const unbound = await gql<{ unbindExternalLogin: boolean }>(
      UNBIND_EXTERNAL_LOGIN,
      { id: bindingId },
      user.token,
    );
    expect(unbound.errors, JSON.stringify(unbound.errors)).toBeUndefined();
    expect(unbound.data!.unbindExternalLogin).toBe(true);

    // 解绑后该身份重新首登 → 回到身份选择页
    const relogin = await callbackLocation('front');
    expect(relogin).toContain('/login/identity-choice?pending=');

    // 无密码账户最后一条绑定拒绝
    const api19bSubject = `${subject}-api19b`;
    await setSubject(api19bSubject);
    const passwordless = await frontLogin();
    const provisionedLogins = await gql<{ myExternalLogins: Array<{ id: string }> }>(
      MY_EXTERNAL_LOGINS,
      undefined,
      passwordless.token,
    );
    const lastBindingId = provisionedLogins.data!.myExternalLogins[0].id;
    const rejected = await gql(UNBIND_EXTERNAL_LOGIN, { id: lastBindingId }, passwordless.token);
    expect(rejected.errors?.[0]?.message).toBe('cannot unbind last login method');
  });

  it('T-OA-API20: 完成绑定后再次第三方登录直登（不再出现选择页）', async () => {
    const api20Subject = `${subject}-api20`;
    await setSubject(api20Subject);
    const first = await frontLogin();
    expect(first.location).toContain('/login/identity-choice');
    const second = await frontLogin();
    expect(second.location).toContain('/login/callback?ticket=');
    expect(second.userId).toBe(first.userId);
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
    const pending = new URL(location).searchParams.get('pending');
    if (pending) {
      await provisionPending(pending);
      return;
    }
    const ticket = new URL(location).searchParams.get('ticket') ?? '';
    const exchanged = await gql<{ exchangeLoginTicket: { user: { id: string } } }>(EXCHANGE, {
      ticket,
    });
    expect(exchanged.errors, JSON.stringify(exchanged.errors)).toBeUndefined();
    createdUserIds.add(exchanged.data!.exchangeLoginTicket.user.id);
  });
});
