/**
 * Admin 第三方登录配置 API（T-AP-API*）。
 *
 * 契约：`contracts/admin-auth-provider.graphql`
 * - `authproviders` 唯一写方 = admin-api；secret 仅写入不回显（任意响应路径不得出现明文/密文）；
 * - `github_oauth` 全平台单条，重复 upsert 幂等；
 * - `adminAuthProviders` 免登录且仅返回 enabled + enableAdminLogin；
 *   agent-api `authProviders` 免登录且仅返回 enabled + enableFrontLogin。
 *
 * 依赖：admin-api + agent-api 就绪、`INTERNAL_API_TOKEN`（管理员归一化可能用到）与
 * `MONGODB_URI`（加密往返断言；缺失时该断言跳过）。不调用真实 IdP。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { adminGql, ensureAdminLogin } from './helpers.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

interface OidcProvider {
  id: string;
  displayName: string;
  issuer: string;
  clientId: string;
  scopes: string;
  enabled: boolean;
  enableFrontLogin: boolean;
  enableAdminLogin: boolean;
  hasSecret: boolean;
  callbackUrl: string;
}

interface GithubConfig {
  id: string;
  clientId: string;
  enabled: boolean;
  enableFrontLogin: boolean;
  enableAdminLogin: boolean;
  hasSecret: boolean;
  callbackUrl: string;
}

const OIDC_LIST = `
  query OidcProviders {
    oidcProviders {
      id displayName issuer clientId scopes enabled enableFrontLogin enableAdminLogin hasSecret callbackUrl
    }
  }
`;

const CREATE_OIDC = `
  mutation CreateOidc($input: OidcProviderInput!) {
    createOidcProvider(input: $input) {
      id displayName issuer clientId scopes enabled enableFrontLogin enableAdminLogin hasSecret callbackUrl
    }
  }
`;

const UPDATE_OIDC = `
  mutation UpdateOidc($id: ID!, $input: OidcProviderInput!) {
    updateOidcProvider(id: $id, input: $input) {
      id displayName clientId enabled enableFrontLogin enableAdminLogin hasSecret
    }
  }
`;

const DELETE_OIDC = `
  mutation DeleteOidc($id: ID!) { deleteOidcProvider(id: $id) }
`;

const GITHUB_UPSERT = `
  mutation UpsertGithub($input: GithubOauthInput!) {
    upsertGithubOauthConfig(input: $input) {
      id clientId enabled enableFrontLogin enableAdminLogin hasSecret callbackUrl
    }
  }
`;

const GITHUB_QUERY = `
  query GithubConfig {
    githubOauthConfig { id clientId enabled enableFrontLogin enableAdminLogin hasSecret callbackUrl }
  }
`;

async function publicGql<T>(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
}

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  if (!HAS_MONGO) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
  return mongoose.connection.db ?? null;
}

describe('Admin 第三方登录配置 API（T-AP-API）', () => {
  let adminToken = '';
  let oidcId = '';

  beforeAll(async () => {
    adminToken = await ensureAdminLogin();
  });

  afterAll(async () => {
    if (oidcId) {
      await adminGql(DELETE_OIDC, { id: oidcId }, adminToken).catch(() => undefined);
    }
    // GitHub 为全平台单条：测试后停用，避免影响其他登录页用例
    await adminGql(GITHUB_UPSERT, { input: { enabled: false } }, adminToken).catch(() => undefined);
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => undefined);
  });

  it('T-AP-API1: 配置读写需要管理员 JWT；adminAuthProviders 免登录', async () => {
    const list = await adminGql(OIDC_LIST);
    expect(list.errors?.[0]?.message).toBe('Not authenticated');

    const create = await adminGql(CREATE_OIDC, {
      input: {
        displayName: 'x',
        issuer: 'http://127.0.0.1:1',
        clientId: 'c',
        clientSecret: 's',
      },
    });
    expect(create.errors?.[0]?.message).toBe('Not authenticated');

    const publicProviders = await adminGql(`
      query AdminAuthProviders { adminAuthProviders { id type displayName } }
    `);
    expect(publicProviders.errors).toBeUndefined();
    expect(Array.isArray(publicProviders.data?.adminAuthProviders)).toBe(true);
  });

  it('T-AP-API2: 创建 OIDC 不返回 secret，callbackUrl 指向统一回调', async () => {
    const displayName = `OIDC API ${Date.now()}`;
    const created = await adminGql<{ createOidcProvider: OidcProvider }>(
      CREATE_OIDC,
      {
        input: {
          displayName,
          issuer: 'http://127.0.0.1:19419/',
          clientId: 'api-client',
          clientSecret: 'super-secret-value',
          scopes: 'openid profile email',
          enabled: false,
          enableFrontLogin: true,
          enableAdminLogin: false,
        },
      },
      adminToken,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const provider = created.data!.createOidcProvider;
    oidcId = provider.id;

    expect(provider).toMatchObject({
      displayName,
      issuer: 'http://127.0.0.1:19419',
      clientId: 'api-client',
      hasSecret: true,
      enabled: false,
      enableFrontLogin: true,
      enableAdminLogin: false,
    });
    expect(provider.callbackUrl).toMatch(/\/api\/auth\/oauth\/callback$/);
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('encryptedClientSecret');

    const list = await adminGql<{ oidcProviders: OidcProvider[] }>(OIDC_LIST, undefined, adminToken);
    expect(list.errors).toBeUndefined();
    const listed = list.data!.oidcProviders.find((item) => item.id === provider.id);
    expect(listed).toBeDefined();
    expect(JSON.stringify(listed)).not.toContain('super-secret-value');
  });

  it('T-AP-API3: 校验矩阵（displayName/issuer/clientId/clientSecret/scopes）', async () => {
    const base = {
      displayName: 'OIDC validation',
      issuer: 'http://127.0.0.1:19419',
      clientId: 'client',
      clientSecret: 'secret',
    };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, displayName: '   ' }, 'Display name must be between 1 and 64 characters'],
      [{ ...base, displayName: 'x'.repeat(65) }, 'Display name must be between 1 and 64 characters'],
      [{ ...base, issuer: 'not-a-url' }, 'Issuer must be a valid http(s) URL'],
      [{ ...base, clientId: '   ' }, 'Client ID is required'],
      [{ ...base, clientId: 'x'.repeat(257) }, 'Client ID must be at most 256 characters'],
      [{ ...base, clientSecret: '' }, 'Client secret is required'],
      [{ ...base, scopes: '   ' }, 'Scopes must not be empty'],
    ];

    for (const [input, message] of cases) {
      const result = await adminGql(CREATE_OIDC, { input }, adminToken);
      expect(result.errors?.[0]?.message).toBe(message);
    }
  });

  it('T-AP-API4: 更新省略 secret 保持不变（hasSecret 仍为 true）', async () => {
    expect(oidcId).toBeTruthy();
    const updated = await adminGql<{ updateOidcProvider: OidcProvider }>(
      UPDATE_OIDC,
      { id: oidcId, input: { displayName: 'OIDC API renamed', enabled: true, enableFrontLogin: true } },
      adminToken,
    );
    expect(updated.errors, JSON.stringify(updated.errors)).toBeUndefined();
    expect(updated.data!.updateOidcProvider).toMatchObject({
      displayName: 'OIDC API renamed',
      enabled: true,
      hasSecret: true,
    });
    expect(JSON.stringify(updated)).not.toContain('super-secret-value');

    const db = await mongoDb();
    if (db) {
      const row = await db.collection('authproviders').findOne({
        _id: new mongoose.Types.ObjectId(oidcId),
      });
      expect(row?.encryptedClientSecret).toBeTruthy();
      expect(JSON.stringify(row?.encryptedClientSecret)).not.toContain('super-secret-value');
      expect(row?.encryptedClientSecret).toMatchObject({
        iv: expect.any(String),
        ciphertext: expect.any(String),
        tag: expect.any(String),
      });
    }
  });

  it('T-AP-API5: GitHub OAuth 全平台单条，重复 upsert 幂等', async () => {
    const first = await adminGql<{ upsertGithubOauthConfig: GithubConfig }>(
      GITHUB_UPSERT,
      {
        input: {
          clientId: 'github-client',
          clientSecret: 'github-secret',
          enabled: false,
          enableFrontLogin: true,
          enableAdminLogin: true,
        },
      },
      adminToken,
    );
    expect(first.errors, JSON.stringify(first.errors)).toBeUndefined();
    const config = first.data!.upsertGithubOauthConfig;
    expect(config).toMatchObject({
      clientId: 'github-client',
      hasSecret: true,
      enabled: false,
      enableFrontLogin: true,
      enableAdminLogin: true,
    });
    expect(config.callbackUrl).toMatch(/\/api\/auth\/oauth\/callback$/);
    expect(JSON.stringify(first)).not.toContain('github-secret');

    const second = await adminGql<{ upsertGithubOauthConfig: GithubConfig }>(
      GITHUB_UPSERT,
      { input: { clientId: 'github-client-2' } },
      adminToken,
    );
    expect(second.errors, JSON.stringify(second.errors)).toBeUndefined();
    expect(second.data!.upsertGithubOauthConfig.id).toBe(config.id);
    expect(second.data!.upsertGithubOauthConfig.clientId).toBe('github-client-2');

    const query = await adminGql<{ githubOauthConfig: GithubConfig | null }>(
      GITHUB_QUERY,
      undefined,
      adminToken,
    );
    expect(query.data!.githubOauthConfig?.id).toBe(config.id);

    if (HAS_MONGO) {
      const db = await mongoDb();
      const count = await db!.collection('authproviders').countDocuments({ type: 'github_oauth' });
      expect(count).toBe(1);
    }
  });

  it('T-AP-API6: 免登录配置查询按启停/应用范围过滤', async () => {
    expect(oidcId).toBeTruthy();

    await adminGql(
      UPDATE_OIDC,
      {
        id: oidcId,
        input: { enabled: true, enableFrontLogin: true, enableAdminLogin: true },
      },
      adminToken,
    );

    const adminView = await adminGql<{
      adminAuthProviders: Array<{ id: string; type: string }>;
    }>(`query { adminAuthProviders { id type displayName } }`);
    expect(adminView.errors).toBeUndefined();
    expect(adminView.data!.adminAuthProviders.some((item) => item.id === oidcId)).toBe(true);

    const frontView = await publicGql<{
      authProviders: Array<{ id: string; type: string }>;
    }>(`query { authProviders { id type displayName } }`);
    expect(frontView.errors).toBeUndefined();
    expect(frontView.data!.authProviders.some((item) => item.id === oidcId)).toBe(true);

    await adminGql(UPDATE_OIDC, { id: oidcId, input: { enabled: false } }, adminToken);

    const disabledAdmin = await adminGql<{
      adminAuthProviders: Array<{ id: string }>;
    }>(`query { adminAuthProviders { id } }`);
    expect(disabledAdmin.data!.adminAuthProviders.some((item) => item.id === oidcId)).toBe(false);

    const disabledFront = await publicGql<{ authProviders: Array<{ id: string }> }>(
      `query { authProviders { id } }`,
    );
    expect(disabledFront.data!.authProviders.some((item) => item.id === oidcId)).toBe(false);
  });

  it('T-AP-API7: 删除后不再出现在列表', async () => {
    expect(oidcId).toBeTruthy();
    const deleted = await adminGql<{ deleteOidcProvider: boolean }>(
      DELETE_OIDC,
      { id: oidcId },
      adminToken,
    );
    expect(deleted.errors, JSON.stringify(deleted.errors)).toBeUndefined();
    expect(deleted.data!.deleteOidcProvider).toBe(true);

    const list = await adminGql<{ oidcProviders: OidcProvider[] }>(OIDC_LIST, undefined, adminToken);
    expect(list.data!.oidcProviders.some((item) => item.id === oidcId)).toBe(false);
    oidcId = '';
  });
});
