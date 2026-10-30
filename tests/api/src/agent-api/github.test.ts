import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';
import { startMockGitHubServer, type MockGitHubServer } from '../mock-github-server.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const API_BASE = API_URL.replace(/\/graphql\/?$/, '');
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const HAS_MONGO = Boolean(MONGODB_URI);
const GITHUB_API_BASE = process.env.GITHUB_API_BASE ?? '';
let githubMock: MockGitHubServer | null = null;

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

const GITHUB_APP_URL = `
  query GetGithubAppUrl {
    githubAppUrl { url state }
  }
`;

const GITHUB_ACCOUNTS = `
  query GetGithubAccounts {
    githubAccounts { id githubLogin githubUserId }
  }
`;

const UNBIND = `
  mutation Unbind($accountId: ID!) {
    unbindGitHubAccount(accountId: $accountId)
  }
`;

const COMMIT_SETTINGS = `
  query GetCommitSettings {
    commitSettings {
      committerType
      customName
      customEmail
    }
  }
`;

const UPDATE_COMMIT_SETTINGS = `
  mutation UpdateCommitSettings($input: CommitSettingsInput!) {
    updateCommitSettings(input: $input) {
      committerType
      customName
      customEmail
    }
  }
`;

const PERSONAL_GITHUB_ACCOUNTS = `
  query GetPersonalGithubAccounts {
    personalGithubAccounts { id githubUserId githubLogin githubAvatarUrl }
  }
`;

describe('GitHub Binding API', () => {
  let token = '';
  let userId = '';

  beforeAll(async () => {
    // 服务端 GITHUB_API_BASE 指向本机固定端口：测试内自起 mock，避免依赖外部进程
    if (GITHUB_API_BASE) {
      const port = Number(new URL(GITHUB_API_BASE).port || 80);
      try {
        githubMock = await startMockGitHubServer({ port });
      } catch {
        // 端口已被外部 mock 占用时复用外部服务
        githubMock = null;
      }
    }
    const frontUser = await createFrontUser();
    token = frontUser.token;
    userId = frontUser.userId;
  });

  async function mongoDb(): Promise<mongoose.mongo.Db | null> {
    if (!MONGODB_URI) return null;
    if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
    return mongoose.connection.db ?? null;
  }

  afterAll(async () => {
    const db = await mongoDb().catch(() => null);
    if (!db) return;
    const objectId = new mongoose.Types.ObjectId(userId);
    await db.collection('user_commit_settings').deleteMany({ userId });
    await db.collection('githubaccounts').deleteMany({ userId });
    await db.collection('cloud_host_github_bindings').deleteMany({ userId: objectId });
  });

  describe('githubAppUrl', () => {
    it('should reject unauthenticated request', async () => {
      const res = await gqlRequest(GITHUB_APP_URL);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return URL with state for authenticated user', async () => {
      const res = await gqlRequest(GITHUB_APP_URL, undefined, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.githubAppUrl).toBeDefined();
      expect(body.data.githubAppUrl.url).toContain('github.com/apps/');
      expect(body.data.githubAppUrl.state).toBeDefined();
      expect(typeof body.data.githubAppUrl.state).toBe('string');
    });
  });

  describe('githubAccounts', () => {
    it('should reject unauthenticated request', async () => {
      const res = await gqlRequest(GITHUB_ACCOUNTS);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return empty list for new user', async () => {
      const res = await gqlRequest(GITHUB_ACCOUNTS, undefined, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.githubAccounts).toEqual([]);
    });
  });

  describe('unbindGitHubAccount', () => {
    it('should reject unauthenticated request', async () => {
      const res = await gqlRequest(UNBIND, { accountId: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return false for non-existent account', async () => {
      const res = await gqlRequest(UNBIND, { accountId: '000000000000000000000000' }, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.unbindGitHubAccount).toBe(false);
    });
  });

  describe('Commit Settings API', () => {
    async function update(input: Record<string, unknown>, authToken = token) {
      const res = await gqlRequest(UPDATE_COMMIT_SETTINGS, { input }, authToken);
      return res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>;
    }

    it('T-CS-API1: 未认证拒绝；从未保存返回 UNSET 默认值', async () => {
      const unauth = await gqlRequest(COMMIT_SETTINGS);
      const unauthBody = await unauth.json();
      expect(unauthBody.errors?.[0]?.message).toBe('Not authenticated');

      const res = await gqlRequest(COMMIT_SETTINGS, undefined, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.commitSettings).toEqual({
        committerType: 'UNSET',
        customName: null,
        customEmail: null,
      });
    });

    it('T-CS-API2: 保存 / 回读自定义提交人（trim 归一）', async () => {
      const saved = await update({
        committerType: 'CUSTOM',
        customName: '  Zhang San  ',
        customEmail: '  zhangsan@example.com  ',
      });
      expect(saved.errors).toBeUndefined();
      expect(saved.data.updateCommitSettings).toEqual({
        committerType: 'CUSTOM',
        customName: 'Zhang San',
        customEmail: 'zhangsan@example.com',
      });

      const res = await gqlRequest(COMMIT_SETTINGS, undefined, token);
      const body = await res.json();
      expect(body.data.commitSettings).toEqual(saved.data.updateCommitSettings);

      // 落库口径（返工回归）：tenantId = 成员归属租户；单成员仅一行，跨工作区上下文同一份
      const mongo = await mongoDb();
      if (mongo) {
        const rows = await mongo.collection('user_commit_settings').find({ userId }).toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0].tenantId).toBe(userId);
        expect(rows[0].workspaceId).toBeUndefined();
        expect(rows[0].committerMode).toBeUndefined();
      }
    });

    it('T-CS-API3: 白名单 invalid custom committer 逐字 + 校验矩阵', async () => {
      const emptyName = await update({ committerType: 'CUSTOM', customName: '', customEmail: 'a@b.com' });
      expect(emptyName.errors?.[0]?.message).toBe('invalid custom committer');

      const badEmail = await update({ committerType: 'CUSTOM', customName: 'A', customEmail: 'not-an-email' });
      expect(badEmail.errors?.[0]?.message).toBe('invalid custom committer');

      const newline = await update({ committerType: 'CUSTOM', customName: 'A\nB', customEmail: 'a@b.com' });
      expect(newline.errors?.[0]?.message).toBe('invalid custom committer');

      const tooLong = await update({
        committerType: 'CUSTOM',
        customName: 'x'.repeat(101),
        customEmail: 'a@b.com',
      });
      expect(tooLong.errors?.[0]?.message).toBe('invalid custom committer');

      // 已下线的 GITHUB_ACCOUNT 枚举：GraphQL 层直接拒绝（不再是白名单业务错误）
      const legacyType = await update({ committerType: 'GITHUB_ACCOUNT' });
      expect(legacyType.errors?.[0]?.message).toContain('CommitterType');
    });

    it('T-CS-API4: 成员级隔离（A/B 互不影响）', async () => {
      await update({ committerType: 'CUSTOM', customName: 'Alice', customEmail: 'alice@example.com' });

      const other = await createFrontUser();
      const otherRead = await gqlRequest(COMMIT_SETTINGS, undefined, other.token);
      const otherBody = await otherRead.json();
      expect(otherBody.data.commitSettings).toEqual({
        committerType: 'UNSET',
        customName: null,
        customEmail: null,
      });

      const otherRes = await gqlRequest(
        UPDATE_COMMIT_SETTINGS,
        { input: { committerType: 'CUSTOM', customName: 'Bob', customEmail: 'bob@example.com' } },
        other.token,
      );
      const otherSaved = await otherRes.json();
      expect(otherSaved.data.updateCommitSettings).toMatchObject({ customName: 'Bob' });

      // 原成员设置不受他人影响
      const mine = await gqlRequest(COMMIT_SETTINGS, undefined, token);
      const mineBody = await mine.json();
      expect(mineBody.data.commitSettings).toMatchObject({ customName: 'Alice' });

      // 清理：他人设置随个人租户留档，测试结束删除
      const mongo = await mongoDb();
      await mongo?.collection('user_commit_settings').deleteMany({ userId: other.userId });
    });

    it('T-CS-API5: personalGithubAccounts 仅返回个人租户绑定帐号（排除普通工作区副本）', async () => {
      const mongo = await mongoDb();
      expect(mongo).toBeTruthy();
      if (!mongo) return;

      const globalWorkspace = await mongo.collection('workspaces').findOne({ tenantId: new mongoose.Types.ObjectId(userId), type: 'global' });
      expect(globalWorkspace).toBeTruthy();
      const normalWorkspaceId = new mongoose.Types.ObjectId();
      await mongo.collection('workspaces').insertOne({
        _id: normalWorkspaceId,
        tenantId: new mongoose.Types.ObjectId(userId),
        name: 'normal-workspace',
        type: 'normal',
        createdBy: new mongoose.Types.ObjectId(userId),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const personalAccountId = new mongoose.Types.ObjectId();
      const workspaceAccountId = new mongoose.Types.ObjectId();
      await mongo.collection('githubaccounts').insertMany([
        {
          _id: personalAccountId,
          userId,
          tenantId: userId,
          workspaceId: String(globalWorkspace!._id),
          githubUserId: 9001,
          githubLogin: 'personal-octocat',
          githubAvatarUrl: 'https://avatars.example/1.png',
          accessToken: 'encrypted',
          tokenExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          _id: workspaceAccountId,
          userId,
          tenantId: userId,
          workspaceId: String(normalWorkspaceId),
          githubUserId: 9002,
          githubLogin: 'workspace-octocat',
          githubAvatarUrl: null,
          accessToken: 'encrypted',
          tokenExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const res = await gqlRequest(PERSONAL_GITHUB_ACCOUNTS, undefined, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const ids = (body.data.personalGithubAccounts as Array<{ id: string }>).map((a) => a.id);
      expect(ids).toContain(personalAccountId.toString());
      expect(ids).not.toContain(workspaceAccountId.toString());

      await mongo.collection('githubaccounts').deleteMany({ _id: { $in: [personalAccountId, workspaceAccountId] } });
      await mongo.collection('workspaces').deleteOne({ _id: normalWorkspaceId });
    });
  });
});

describe.skipIf(!INTERNAL_TOKEN || !HAS_MONGO)('Commit Identity Internal API', () => {
  const CONTROLLER_ID = new mongoose.Types.ObjectId().toString();
  const HOST_ID = new mongoose.Types.ObjectId();
  const HOST_USER_ID = new mongoose.Types.ObjectId();

  async function db(): Promise<mongoose.mongo.Db> {
    if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI!);
    return mongoose.connection.db!;
  }

  async function seedHost(): Promise<void> {
    const mongo = await db();
    const keyId = new mongoose.Types.ObjectId();
    const now = new Date();
    await mongo.collection('controllers').insertOne({
      _id: new mongoose.Types.ObjectId(CONTROLLER_ID),
      userId: HOST_USER_ID,
      tenantId: HOST_USER_ID,
      name: 'commit-identity-test',
      hostname: 'commit-identity-test',
      type: 'cloud',
      status: 'registering',
      keyId,
      version: '0.0.0',
      createdAt: now,
      updatedAt: now,
    });
    await mongo.collection('cloudhosts').insertOne({
      _id: HOST_ID,
      userId: HOST_USER_ID,
      tenantId: HOST_USER_ID,
      name: 'commit-identity-test',
      harnessTypes: ['OPENCODE'],
      status: 'RUNNING',
      controllerId: new mongoose.Types.ObjectId(CONTROLLER_ID),
      keyId,
      workspaceId: null,
      containerId: `container-${HOST_ID.toString()}`,
      defaultSessionId: null,
      createDefaultSession: true,
      startedAt: now,
      readyAt: now,
      stoppedAt: null,
      failureReason: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function setSetting(setting: Record<string, unknown>): Promise<void> {
    const mongo = await db();
    await mongo.collection('user_commit_settings').updateOne(
      { userId: HOST_USER_ID.toString() },
      {
        $set: {
          userId: HOST_USER_ID.toString(),
          tenantId: HOST_USER_ID.toString(),
          customName: null,
          customEmail: null,
          updatedAt: new Date(),
          ...setting,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  async function identity(token: string | null = INTERNAL_TOKEN) {
    return fetch(`${API_BASE}/internal/cloud-hosts/${CONTROLLER_ID}/commit-identity`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  beforeAll(async () => {
    if (GITHUB_API_BASE) {
      const port = Number(new URL(GITHUB_API_BASE).port || 80);
      try {
        githubMock = await startMockGitHubServer({ port });
      } catch {
        githubMock = null;
      }
    }
  });

  afterAll(async () => {
    const mongo = await db().catch(() => null);
    if (!mongo) return;
    await mongo.collection('cloudhosts').deleteOne({ _id: HOST_ID });
    await mongo.collection('controllers').deleteOne({ _id: new mongoose.Types.ObjectId(CONTROLLER_ID) });
    await mongo.collection('user_commit_settings').deleteMany({ userId: HOST_USER_ID.toString() });
    await githubMock?.close();
    githubMock = null;
  });

  it('T-IC-API1: 双鉴权 401 + 已鉴权请求永不 404（未知主机 200 unset）', async () => {
    expect((await identity(null)).status).toBe(401);
    expect((await identity('wrong-token')).status).toBe(401);

    const unknown = await fetch(
      `${API_BASE}/internal/cloud-hosts/${new mongoose.Types.ObjectId().toString()}/commit-identity`,
      { method: 'POST', headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` } },
    );
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ mode: 'unset' });
  });

  it('T-IC-API2: 恒 bot（无视个人设置）', async () => {
    await seedHost();
    // 个人设置即便为 custom，也不影响云电脑身份
    await setSetting({ committerType: 'custom', customName: 'Zhang San', customEmail: 'zhangsan@example.com' });

    const response = await identity();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    if (!GITHUB_API_BASE) {
      // 无 bot mock 时优雅降级 unset（容器不写身份）
      expect(body).toEqual({ mode: 'unset' });
      return;
    }
    expect(body).toMatchObject({ mode: 'agent_only' });
    expect(body.name).toBe('zag-test-bot[bot]');
    expect(body.email).toBe('424242+zag-test-bot[bot]@users.noreply.github.com');
  });

  it('T-IC-API3: bot 解析失败兜底 { mode: "unset" }', async () => {
    if (!githubMock) return; // 无 mock 时无法注入失败
    githubMock.failNext(500, 2);
    const response = await identity();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: 'unset' });
  });

  it('T-IC-API4: 响应恒含 mode 包络（兼容 2.11.x 容器 consume）', async () => {
    const response = await identity();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.mode).toBe('string');
    expect(['agent_only', 'unset']).toContain(body.mode);
  });
});
