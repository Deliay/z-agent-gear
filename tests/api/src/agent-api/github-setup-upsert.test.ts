/**
 * GitHub App setup 回调（`GET /api/github/setup`）API 回归。
 *
 * 背景（PR #360）：`handleSetup` 的 upsert 同时写 `$set.tenantId` 与
 * `$setOnInsert.userId`，tenant-scope 插件又向 `$setOnInsert` 注入 `tenantId`，
 * MongoDB 抛 ConflictingUpdateOperators(code 40)，绑定失败。
 *
 * 本用例走真实 HTTP 回调 + 进程内 GitHub mock：
 * 1. GraphQL `githubAppUrl` 取 state（服务端写入 Redis，携带当前工作区）；
 * 2. 以 mock 的 installation_id 回调 `/api/github/setup`；
 * 3. 连续两次绑定（第二次走更新路径），断言 302 success、只落一行、token 加密。
 *
 * 依赖：agent-api 就绪 + `INTERNAL_API_TOKEN`（造用户）+ `MONGODB_URI`（落库断言）+
 * `GITHUB_API_BASE`（启动 mock 并由 agent-api 指向）。缺 `GITHUB_API_BASE` 时跳过。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createFrontUser, type FrontUser } from '../support/front-users.js';
import { startMockGitHubServer, type MockGitHubServer } from '../mock-github-server.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const API_BASE = API_URL.replace(/\/graphql\/?$/, '');
const GITHUB_API_BASE = process.env.GITHUB_API_BASE ?? '';
const HAS_MONGO = Boolean(process.env.MONGODB_URI);
const ENABLED = Boolean(GITHUB_API_BASE && HAS_MONGO && process.env.INTERNAL_API_TOKEN);

let githubMock: MockGitHubServer | null = null;

const GITHUB_APP_URL = `
  query GithubAppUrl {
    githubAppUrl { url state }
  }
`;

const GITHUB_ACCOUNTS = `
  query GithubAccounts {
    githubAccounts { id githubUserId githubLogin workspaceId }
  }
`;

async function gql<T>(
  query: string,
  token: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
}

async function mongoDb(): Promise<mongoose.mongo.Db> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
  return mongoose.connection.db!;
}

async function setupCallback(state: string): Promise<Response> {
  return fetch(
    `${API_BASE}/api/github/setup?installation_id=424242&state=${encodeURIComponent(state)}`,
    { redirect: 'manual' },
  );
}

describe.skipIf(!ENABLED)('GitHub setup API（tenant-scope upsert 回归）', () => {
  let user: FrontUser;
  let workspaceId = '';

  beforeAll(async () => {
    if (GITHUB_API_BASE) {
      const port = Number(new URL(GITHUB_API_BASE).port || 80);
      try {
        githubMock = await startMockGitHubServer({ port });
      } catch {
        // 端口已被外部 mock 占用时复用外部服务
        githubMock = null;
      }
    }
    user = await createFrontUser();
  });

  afterAll(async () => {
    const db = await mongoDb();
    await db.collection('githubaccounts').deleteMany({ userId: user.userId });
    await db.collection('githubinstallations').deleteMany({ githubUserId: 9001 });
    await githubMock?.close();
    githubMock = null;
  });

  it('T-GHS-API1/2: 首次与重复绑定均 success，且只落一行（不触发 code 40）', async () => {
    // 默认上下文 = 个人全局工作区；state 由服务端写入 Redis（含 workspaceId）
    const firstUrl = await gql<{ githubAppUrl: { url: string; state: string } }>(
      GITHUB_APP_URL,
      user.token,
    );
    expect(firstUrl.errors, JSON.stringify(firstUrl.errors)).toBeUndefined();
    const firstState = firstUrl.data!.githubAppUrl.state;

    const first = await setupCallback(firstState);
    expect(first.status).toBe(302);
    expect(first.headers.get('location') ?? '').toContain('binding=success');

    const accounts = await gql<{ githubAccounts: Array<Record<string, unknown>> }>(
      GITHUB_ACCOUNTS,
      user.token,
    );
    expect(accounts.errors, JSON.stringify(accounts.errors)).toBeUndefined();
    expect(accounts.data!.githubAccounts).toHaveLength(1);
    expect(accounts.data!.githubAccounts[0]).toMatchObject({
      githubUserId: 9001,
      githubLogin: 'octo-org',
    });
    workspaceId = String(accounts.data!.githubAccounts[0].workspaceId);
    expect(workspaceId).toMatch(/^[0-9a-f]{24}$/);

    // 第二次绑定走同一 upsert 的更新路径：修复前这里会因 tenantId 路径冲突 500
    const secondUrl = await gql<{ githubAppUrl: { url: string; state: string } }>(
      GITHUB_APP_URL,
      user.token,
    );
    const second = await setupCallback(secondUrl.data!.githubAppUrl.state);
    expect(second.status).toBe(302);
    expect(second.headers.get('location') ?? '').toContain('binding=success');

    const db = await mongoDb();
    expect(
      await db.collection('githubaccounts').countDocuments({ userId: user.userId, githubUserId: 9001 }),
    ).toBe(1);
    const row = await db.collection('githubaccounts').findOne({
      userId: user.userId,
      githubUserId: 9001,
    });
    expect(row).toMatchObject({
      tenantId: user.tenantId,
      workspaceId,
      githubUserId: 9001,
      githubLogin: 'octo-org',
    });
    // 凭据落库必须是密文（iv:tag:ciphertext），不得回显 mock token 明文
    expect(typeof row!.accessToken).toBe('string');
    expect(row!.accessToken).not.toBe('mock-installation-token');
    expect(String(row!.accessToken).split(':')).toHaveLength(3);
  });

  it('T-GHS-API3: installation 落库含 mock 仓库清单', async () => {
    const db = await mongoDb();
    const installation = await db
      .collection('githubinstallations')
      .findOne({ installationId: 424242 });
    expect(installation).toBeTruthy();
    expect(installation!.githubUserId).toBe(9001);
    expect(installation!.repos).toEqual([
      expect.objectContaining({
        repoId: 7001,
        repoName: 'demo',
        fullName: 'octo-org/demo',
        private: false,
      }),
    ]);
  });
});
