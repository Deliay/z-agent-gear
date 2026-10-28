import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';

// 云主机工作负载/ Github 设置 API（需要 Aspire 全量服务 + MONGODB_URI + HARNESS_ENABLED=true）。
// 不调用真实 GitHub：成功签发 token 由 services/github.test.ts 覆盖。
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then((res) => res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>);
}

const WORKLOADS = `
  query Workloads($controllerId: ID!) {
    cloudHostWorkloads(controllerId: $controllerId) {
      workloadId name workloadKind isPreset installed installedAt source paramSchema dependsOnWorkloadIds
    }
  }
`;

const CATALOG = `
  query Catalog {
    cloudHostWorkloadCatalog {
      workloadId name workloadKind isPreset installed installedAt source dependsOnWorkloadIds
    }
  }
`;

const SETUP = `
  mutation Setup($input: SetupCloudHostGithubProjectInput!) {
    setupCloudHostGithubProject(input: $input) {
      id kind status steps { key status detail } sessionId error
    }
  }
`;

const OPERATION = `
  query Operation($id: ID!) {
    cloudHostSetupOperation(id: $id) { id kind status steps { key status detail } }
  }
`;

const RETRY = `
  mutation Retry($id: ID!) {
    retryCloudHostSetupOperation(id: $id) { id status }
  }
`;

async function newFrontUser(): Promise<{ token: string; userId: string; username: string }> {
  return createFrontUser();
}

describe.skipIf(!HARNESS_ENABLED || !HAS_MONGO)('Cloud Host Workload & Github API', () => {
  async function seedHost(userId: string) {
    const db = await mongoDb();
    if (!db) throw new Error('MONGODB_URI missing');
    const controllerId = new mongoose.Types.ObjectId();
    const hostId = new mongoose.Types.ObjectId();
    const workspaceId = new mongoose.Types.ObjectId();
    const keyId = new mongoose.Types.ObjectId();
    await db.collection('controllers').insertOne({
      _id: controllerId,
      userId: new mongoose.Types.ObjectId(userId),
      tenantId: new mongoose.Types.ObjectId(userId),
      name: 'e2e-cloud',
      hostname: 'e2e-cloud',
      type: 'cloud',
      status: 'online',
      keyId,
      version: '2.6.0',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('controllerworkspaces').insertOne({
      _id: workspaceId,
      userId: new mongoose.Types.ObjectId(userId),
      tenantId: new mongoose.Types.ObjectId(userId),
      controllerId,
      name: 'workspace',
      path: '/home/worker/workspace',
      isEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('cloudhosts').insertOne({
      _id: hostId,
      userId: new mongoose.Types.ObjectId(userId),
      tenantId: new mongoose.Types.ObjectId(userId),
      name: 'e2e-cloud',
      harnessTypes: ['OPENCODE'],
      status: 'RUNNING',
      controllerId,
      keyId,
      workspaceId,
      containerId: new mongoose.Types.ObjectId().toString(),
      startedAt: new Date(),
      readyAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return {
      db,
      controllerId: controllerId.toString(),
      hostId: hostId.toString(),
      cleanup: async () => {
        await db.collection('cloudhosts').deleteOne({ _id: hostId });
        await db.collection('controllerworkspaces').deleteOne({ _id: workspaceId });
        await db.collection('controllers').deleteOne({ _id: controllerId });
        await db
          .collection('cloud_host_setup_operations')
          .deleteMany({ controllerId: new mongoose.Types.ObjectId(controllerId) });
        await db
          .collection('cloud_host_github_bindings')
          .deleteMany({ controllerId: new mongoose.Types.ObjectId(controllerId) });
      },
    };
  }

  async function seedGithubAccount(userId: string) {
    const db = await mongoDb();
    if (!db) throw new Error('MONGODB_URI missing');
    const accountId = new mongoose.Types.ObjectId();
    const installationId = Math.floor(Date.now() % 1_000_000_000) + Math.floor(Math.random() * 1000);
    await db.collection('githubaccounts').insertOne({
      _id: accountId,
      userId,
      tenantId: userId,
      githubUserId: installationId,
      githubLogin: `gh-${accountId.toString()}`,
      accessToken: 'encrypted',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('githubinstallations').insertOne({
      accountId,
      installationId,
      accountLogin: `gh-${accountId.toString()}`,
      accountType: 'User',
      repos: [
        {
          repoId: 1,
          repoName: 'repo',
          fullName: 'owner/repo',
          private: false,
          permissions: { read: true, write: true },
        },
        {
          repoId: 2,
          repoName: 'repo2',
          fullName: 'owner/repo2',
          private: false,
          permissions: { read: true, write: true },
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return {
      accountId: accountId.toString(),
      cleanup: async () => {
        await db.collection('githubinstallations').deleteMany({ accountId });
        await db.collection('githubaccounts').deleteOne({ _id: accountId });
      },
    };
  }

  it('T-CHW-API1: 列表返回 Github 预制项并校验主机归属', async () => {
    const owner = await newFrontUser();
    const other = await newFrontUser();
    const seeded = await seedHost(owner.userId);
    try {
      const own = await gql(WORKLOADS, { controllerId: seeded.controllerId }, owner.token);
      expect(own.errors).toBeUndefined();
      expect(Array.isArray(own.data.cloudHostWorkloads)).toBe(true);

      const foreign = await gql(WORKLOADS, { controllerId: seeded.controllerId }, other.token);
      expect(foreign.errors?.[0]?.message).toBe('Cloud host not found');
    } finally {
      await seeded.cleanup();
    }
  });

  it('T-CHG-API1: 相对路径/未授权仓库校验与 operation 归属', async () => {
    const { token, userId } = await newFrontUser();
    const seeded = await seedHost(userId);
    try {
      const relative = await gql(
        SETUP,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: new mongoose.Types.ObjectId().toString(),
            repoFullName: 'owner/repo',
            targetPath: 'relative/path',
          },
        },
        token,
      );
      expect(relative.errors?.[0]?.message).toBe('前缀地址必须以 / 或 ~ 开头');

      const traversal = await gql(
        SETUP,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: new mongoose.Types.ObjectId().toString(),
            repoFullName: 'owner/repo',
            targetPath: '/home/worker/../etc',
          },
        },
        token,
      );
      expect(traversal.errors?.[0]?.message).toBe('前缀地址不能包含 ..');

      const invalidRepo = await gql(
        SETUP,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: new mongoose.Types.ObjectId().toString(),
            repoFullName: 'not-a-repo',
            targetPath: '/home/worker/workspace',
          },
        },
        token,
      );
      expect(invalidRepo.errors?.[0]?.message).toBe('仓库格式应为 owner/repo');

      const retry = await gql(
        RETRY,
        { id: new mongoose.Types.ObjectId().toString() },
        token,
      );
      expect(retry.errors?.[0]?.message).toBe('Operation not found');
    } finally {
      await seeded.cleanup();
    }
  });

  it('T-GH-API-P3: 合法前缀通过校验后在授权处返回原错误', async () => {
    const { token, userId } = await newFrontUser();
    const seeded = await seedHost(userId);
    try {
      const unauthorized = await gql(
        SETUP,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: new mongoose.Types.ObjectId().toString(),
            repoFullName: 'owner/repo',
            targetPath: '/home/worker/workspace/',
          },
        },
        token,
      );
      expect(unauthorized.errors?.[0]?.message).toBe('Github 账号不存在或不属于当前用户');
    } finally {
      await seeded.cleanup();
    }
  });

  it('T-GH-API-P4: ~ 前缀矩阵（合法形态归一后进入授权校验，非法形态拒绝）', async () => {
    const { token, userId } = await newFrontUser();
    const seeded = await seedHost(userId);
    try {
      const setup = (targetPath: string) =>
        gql(
          SETUP,
          {
            input: {
              controllerId: seeded.controllerId,
              accountId: new mongoose.Types.ObjectId().toString(),
              repoFullName: 'owner/repo',
              targetPath,
            },
          },
          token,
        );

      // 合法 ~ 形态通过归一，进入 Github 账号归属校验
      for (const targetPath of ['~/workspace', '~', '~/', '~//a', '/a/~']) {
        const result = await setup(targetPath);
        expect(result.errors?.[0]?.message).toBe(
          'Github 账号不存在或不属于当前用户',
        );
      }

      expect((await setup('~abc')).errors?.[0]?.message).toBe(
        '前缀地址必须以 / 或 ~ 开头',
      );
      expect((await setup('~x/y')).errors?.[0]?.message).toBe(
        '前缀地址必须以 / 或 ~ 开头',
      );
      expect((await setup('~/a/../b')).errors?.[0]?.message).toBe(
        '前缀地址不能包含 ..',
      );
    } finally {
      await seeded.cleanup();
    }
  });

  it('T-GH-API-L1/L2/L3: 首绑落库、异帐号拒绝、同帐号换仓库放行', async () => {
    const { token, userId } = await newFrontUser();
    const seeded = await seedHost(userId);
    const account1 = await seedGithubAccount(userId);
    const account2 = await seedGithubAccount(userId);
    const db = (await mongoDb())!;
    try {
      const first = await gql(
        SETUP,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: account1.accountId,
            repoFullName: 'owner/repo',
            targetPath: '/home/worker/workspace',
          },
        },
        token,
      );
      expect(first.errors).toBeUndefined();
      const host = await db.collection('cloudhosts').findOne({
        _id: new mongoose.Types.ObjectId(seeded.hostId),
      });
      expect(String(host?.githubAccountId)).toBe(account1.accountId);

      const foreign = await gql(
        SETUP,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: account2.accountId,
            repoFullName: 'owner/repo',
            targetPath: '/home/worker/workspace',
          },
        },
        token,
      );
      expect(foreign.errors?.[0]?.message).toBe('github account is locked');

      const sameAccount = await gql(
        SETUP,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: account1.accountId,
            repoFullName: 'owner/repo2',
            targetPath: '/home/worker/workspace',
          },
        },
        token,
      );
      expect(sameAccount.errors?.[0]?.message).not.toBe('github account is locked');
    } finally {
      await account1.cleanup();
      await account2.cleanup();
      await seeded.cleanup();
    }
  });

  it('T-CAT-API1/T-CAT-API2: 负载目录需登录且返回 standard 列表', async () => {
    const anonymous = await gql(CATALOG);
    expect(anonymous.errors?.[0]?.message).toBe('Not authenticated');

    const { token } = await newFrontUser();
    const result = await gql(CATALOG, {}, token);
    expect(result.errors).toBeUndefined();
    const items = result.data.cloudHostWorkloadCatalog as Array<Record<string, unknown>>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.workloadKind).toBe('STANDARD');
      expect(item.installed).toBe(false);
      expect(item.installedAt).toBeNull();
      expect(item.source).toBeNull();
    }
    expect(items.map((item) => item.name)).toEqual(
      expect.arrayContaining(['Aspire', 'Docker', '.NET']),
    );
  });
});
