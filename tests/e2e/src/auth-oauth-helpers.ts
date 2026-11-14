import { expect, type Page } from '@playwright/test';
import { adminGqlRequest, adminLoginApi } from './helpers.js';
import { startFakeOidcServer, type FakeOidcServer } from '../../api/src/fake-oidc-server.js';
import { startMockGitHubServer, type MockGitHubServer } from '../../api/src/mock-github-server.js';

/** OAuth/OIDC E2E 共享夹具：进程内 fake IdP/GitHub + admin-api 配置读写。 */
export interface OAuthFixture {
  oidc: FakeOidcServer;
  github: MockGitHubServer;
  adminToken: string;
  oidcProviderId: string;
  githubProviderId: string;
  providerName: string;
  subject: string;
  dispose(): Promise<void>;
}

const OIDC_PORT = Number(process.env.MOCK_OIDC_PORT || 19419);
const GITHUB_PORT = Number(process.env.MOCK_GITHUB_PORT || 19418);

export async function setupOAuthFixture(page: Page): Promise<OAuthFixture> {
  const adminToken = await adminLoginApi(page);
  const oidc = await startFakeOidcServer({
    port: OIDC_PORT,
    clientId: 'e2e-oidc-client',
    clientSecret: 'e2e-oidc-secret',
  });
  const github = await startMockGitHubServer({ port: GITHUB_PORT });
  const subject = `e2e-oidc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  oidc.setClaims({
    sub: subject,
    preferred_username: `e2e${Date.now().toString(36)}`.slice(0, 20),
    name: 'E2E OIDC User',
    email: `e2e-${Date.now()}@example.com`,
  });
  const providerName = `E2E OIDC ${Date.now()}`;

  const created = await adminGqlRequest(
    page,
    `
      mutation CreateOidc($input: OidcProviderInput!) {
        createOidcProvider(input: $input) { id }
      }
    `,
    {
      input: {
        displayName: providerName,
        issuer: oidc.issuer,
        clientId: 'e2e-oidc-client',
        clientSecret: 'e2e-oidc-secret',
        scopes: 'openid profile email',
        enabled: true,
        enableFrontLogin: true,
        enableAdminLogin: true,
      },
    },
    adminToken,
  );
  const createdBody = await created.json();
  if (!createdBody.data?.createOidcProvider?.id) {
    throw new Error(`create OIDC provider failed: ${JSON.stringify(createdBody.errors ?? createdBody)}`);
  }
  const oidcProviderId = createdBody.data.createOidcProvider.id as string;

  const githubRes = await adminGqlRequest(
    page,
    `
      mutation UpsertGithub($input: GithubOauthInput!) {
        upsertGithubOauthConfig(input: $input) { id }
      }
    `,
    {
      input: {
        clientId: 'e2e-github-client',
        clientSecret: 'e2e-github-secret',
        enabled: true,
        enableFrontLogin: true,
        enableAdminLogin: true,
      },
    },
    adminToken,
  );
  const githubBody = await githubRes.json();
  const githubProviderId = githubBody.data?.upsertGithubOauthConfig?.id as string | undefined;

  return {
    oidc,
    github,
    adminToken,
    oidcProviderId,
    githubProviderId: githubProviderId ?? '',
    providerName,
    subject,
    async dispose() {
      await adminGqlRequest(
        page,
        `mutation DeleteOidc($id: ID!) { deleteOidcProvider(id: $id) }`,
        { id: oidcProviderId },
        adminToken,
      ).catch(() => undefined);
      await adminGqlRequest(
        page,
        `mutation DisableGithub($input: GithubOauthInput!) {
          upsertGithubOauthConfig(input: $input) { id }
        }`,
        { input: { enabled: false } },
        adminToken,
      ).catch(() => undefined);
      await oidc.close();
      await github.close();
    },
  };
}

export async function setOidcEnabled(
  page: Page,
  adminToken: string,
  providerId: string,
  enabled: boolean,
): Promise<void> {
  const res = await adminGqlRequest(
    page,
    `mutation UpdateOidc($id: ID!, $input: OidcProviderInput!) {
      updateOidcProvider(id: $id, input: $input) { id enabled }
    }`,
    { id: providerId, input: { enabled } },
    adminToken,
  );
  const body = await res.json();
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
}

export async function clearAdminAuth(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
  });
}

/** 第三方登录按钮文案：OIDC 用 displayName，GitHub 恒用 GitHub。 */
export function providerButtonName(type: 'oidc' | 'github_oauth', displayName: string): RegExp {
  return new RegExp(`使用 ${type === 'github_oauth' ? 'GitHub' : displayName} 登录`);
}
