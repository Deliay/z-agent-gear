import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

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

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) { token user { id } }
  }
`;

const WORKLOADS = `
  query Workloads($controllerId: ID!) {
    cloudHostWorkloads(controllerId: $controllerId) {
      workloadId name isPreset installed installedAt source paramSchema dependsOnWorkloadIds
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

async function signup(): Promise<{ token: string; userId: string }> {
  const username = `gw${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const result = await gql(SIGNUP, { username, password: 'password123' });
  return {
    token: result.data.signup.token as string,
    userId: result.data.signup.user.id as string,
  };
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
      controllerId,
      name: 'workspace',
      path: '/root/workspace',
      isEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('cloudhosts').insertOne({
      _id: hostId,
      userId: new mongoose.Types.ObjectId(userId),
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

  it('T-CHW-API1: 列表返回 Github 预制项并校验主机归属', async () => {
    const owner = await signup();
    const other = await signup();
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
    const { token, userId } = await signup();
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
      expect(relative.errors?.[0]?.message).toBe('目标路径必须是绝对路径');

      const invalidRepo = await gql(
        SETUP,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: new mongoose.Types.ObjectId().toString(),
            repoFullName: 'not-a-repo',
            targetPath: '/root/workspace',
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
});
