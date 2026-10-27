import { describe, it, expect, afterAll } from 'vitest';
import mongoose from 'mongoose';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const API_BASE = API_URL.replace(/\/graphql\/?$/, '');
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const HAS_MONGO = Boolean(MONGODB_URI);

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

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id }
    }
  }
`;

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
      committerMode
      committerType
      githubAccountId
      customName
      customEmail
    }
  }
`;

const UPDATE_COMMIT_SETTINGS = `
  mutation UpdateCommitSettings($input: CommitSettingsInput!) {
    updateCommitSettings(input: $input) {
      committerMode
      committerType
      githubAccountId
      customName
      customEmail
    }
  }
`;

describe('GitHub Binding API', () => {
  let token = '';
  let userId = '';
  const testUsername = `gt_${Date.now()}`;

  beforeAll(async () => {
    const res = await gqlRequest(SIGNUP, { username: testUsername, password: 'password123' });
    const body = await res.json();
    token = body.data.signup.token;
    userId = String(body.data.signup.user.id);
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
    await db.collection('github_accounts').deleteMany({ userId });
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

    it('T-CS-API1: 未认证拒绝；从未保存返回双 UNSET 默认值', async () => {
      const unauth = await gqlRequest(COMMIT_SETTINGS);
      const unauthBody = await unauth.json();
      expect(unauthBody.errors?.[0]?.message).toBe('Not authenticated');

      const res = await gqlRequest(COMMIT_SETTINGS, undefined, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.commitSettings).toEqual({
        committerMode: 'UNSET',
        committerType: 'UNSET',
        githubAccountId: null,
        customName: null,
        customEmail: null,
      });
    });

    it('T-CS-API2: 保存 / 回读自定义提交人全字段', async () => {
      const saved = await update({
        committerMode: 'HUMAN_ONLY',
        committerType: 'CUSTOM',
        customName: '  Zhang San  ',
        customEmail: '  zhangsan@example.com  ',
      });
      expect(saved.errors).toBeUndefined();
      expect(saved.data.updateCommitSettings).toEqual({
        committerMode: 'HUMAN_ONLY',
        committerType: 'CUSTOM',
        githubAccountId: null,
        customName: 'Zhang San',
        customEmail: 'zhangsan@example.com',
      });

      const res = await gqlRequest(COMMIT_SETTINGS, undefined, token);
      const body = await res.json();
      expect(body.data.commitSettings).toEqual(saved.data.updateCommitSettings);
    });

    it('T-CS-API3: 白名单错误逐字（联动 / 越权帐号 / 非法自定义）', async () => {
      const required = await update({ committerMode: 'CO_AUTHOR', committerType: 'UNSET' });
      expect(required.errors?.[0]?.message).toBe(
        'committer is required for the selected mode',
      );

      const account = await update({
        committerMode: 'HUMAN_ONLY',
        committerType: 'GITHUB_ACCOUNT',
        githubAccountId: new mongoose.Types.ObjectId().toString(),
      });
      expect(account.errors?.[0]?.message).toBe('invalid github account');

      const custom = await update({
        committerMode: 'HUMAN_ONLY',
        committerType: 'CUSTOM',
        customName: '',
        customEmail: 'not-an-email',
      });
      expect(custom.errors?.[0]?.message).toBe('invalid custom committer');
    });

    it('T-CS-API4: 归一落库（mode=UNSET 不清提交人、按 type 清理）', async () => {
      const keepCommitter = await update({
        committerMode: 'UNSET',
        committerType: 'CUSTOM',
        customName: 'Keep Me',
        customEmail: 'keep@example.com',
      });
      expect(keepCommitter.errors).toBeUndefined();
      expect(keepCommitter.data.updateCommitSettings).toMatchObject({
        committerMode: 'UNSET',
        committerType: 'CUSTOM',
        customName: 'Keep Me',
        customEmail: 'keep@example.com',
      });

      const cleared = await update({ committerMode: 'UNSET', committerType: 'UNSET' });
      expect(cleared.data.updateCommitSettings).toEqual({
        committerMode: 'UNSET',
        committerType: 'UNSET',
        githubAccountId: null,
        customName: null,
        customEmail: null,
      });
    });
  });
});

describe.skipIf(!INTERNAL_TOKEN || !HAS_MONGO)('Commit Identity Internal API', () => {
  const CONTROLLER_ID = new mongoose.Types.ObjectId().toString();
  const HOST_ID = new mongoose.Types.ObjectId();
  const HOST_USER_ID = new mongoose.Types.ObjectId();
  const ACCOUNT_ID = new mongoose.Types.ObjectId();

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
          githubAccountId: null,
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

  async function identity(token = INTERNAL_TOKEN) {
    return fetch(
      `${API_BASE}/internal/cloud-hosts/${CONTROLLER_ID}/commit-identity`,
      {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    );
  }

  afterAll(async () => {
    const mongo = await db().catch(() => null);
    if (!mongo) return;
    await mongo.collection('cloudhosts').deleteOne({ _id: HOST_ID });
    await mongo
      .collection('controllers')
      .deleteOne({ _id: new mongoose.Types.ObjectId(CONTROLLER_ID) });
    await mongo
      .collection('user_commit_settings')
      .deleteMany({ userId: HOST_USER_ID.toString() });
    await mongo.collection('github_accounts').deleteMany({
      _id: ACCOUNT_ID,
    });
  });

  it('T-CI-API1: 无凭据 / 非法凭据 401（永不 404 仅针对已鉴权请求）', async () => {
    expect((await identity(undefined)).status).toBe(401);
    expect((await identity('wrong-token')).status).toBe(401);
  });

  it('T-CI-API3: 主机不存在 / 未保存设置均 200 unset', async () => {
    const unknown = await fetch(
      `${API_BASE}/internal/cloud-hosts/${new mongoose.Types.ObjectId().toString()}/commit-identity`,
      { method: 'POST', headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` } },
    );
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ mode: 'unset' });

    await seedHost();
    const unsaved = await identity();
    expect(unsaved.status).toBe(200);
    expect(await unsaved.json()).toEqual({ mode: 'unset' });
  });

  it('T-CI-API4: 帐号解绑 / 越权降级 unset', async () => {
    await setSetting({
      committerMode: 'human_only',
      committerType: 'github_account',
      githubAccountId: ACCOUNT_ID,
    });
    const response = await identity();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: 'unset' });
  });

  it('T-CI-API5: human_only 自定义提交人全字段；unset 缺省字段', async () => {
    await setSetting({
      committerMode: 'human_only',
      committerType: 'custom',
      customName: 'Zhang San',
      customEmail: 'zhangsan@example.com',
    });
    const response = await identity();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: 'human_only',
      name: 'Zhang San',
      email: 'zhangsan@example.com',
    });

    await setSetting({ committerMode: 'unset', committerType: 'unset' });
    const unset = await identity();
    const body = (await unset.json()) as Record<string, unknown>;
    expect(body).toEqual({ mode: 'unset' });
    expect(Object.keys(body)).toEqual(['mode']);
  });

  it.skipIf(!process.env.GITHUB_API_BASE)(
    'T-CI-API2: co_author 返回提交人 + bot 全字段（GitHub mock）',
    async () => {
      const mongo = await db();
      await mongo.collection('github_accounts').insertOne({
        _id: ACCOUNT_ID,
        userId: HOST_USER_ID.toString(),
        githubUserId: 777,
        githubLogin: 'octocat',
        githubAvatarUrl: null,
        accessToken: 'encrypted-token',
        tokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await mongo.collection('cloud_host_github_bindings').insertOne({
        userId: HOST_USER_ID,
        controllerId: new mongoose.Types.ObjectId(CONTROLLER_ID),
        accountId: ACCOUNT_ID,
        repoFullName: 'octocat/hello',
        targetPath: '/home/worker/workspace/octocat/hello',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await setSetting({
        committerMode: 'co_author',
        committerType: 'github_account',
        githubAccountId: ACCOUNT_ID,
      });

      const response = await identity();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        mode: 'co_author',
        name: 'octocat',
        email: '777+octocat@users.noreply.github.com',
        coAuthorName: 'zag-test-bot[bot]',
        coAuthorEmail: '424242+zag-test-bot[bot]@users.noreply.github.com',
      });

      await mongo
        .collection('cloud_host_github_bindings')
        .deleteMany({ controllerId: new mongoose.Types.ObjectId(CONTROLLER_ID) });
    },
  );
});
