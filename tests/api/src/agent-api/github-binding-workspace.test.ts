/**
 * 多租户二期：团队工作区 GitHub 共享绑定（T-GH-WS，阻断 A/B/C 回归）
 *
 * 覆盖契约 `contracts/github.graphql` 的工作区口径：
 * - 读（githubAccounts）：当前工作区 ∪ 本租户全局工作区（共享型资源）；
 * - 写（updateCommitSettings 选择提交人）：候选账号与读口径一致（阻断-B：普通工作区可选用
 *   本租户全局共享 GitHubAccount）；
 * - 写（unbindGitHubAccount）：仅允许当前工作区自身行，共享读命中的全局行/他人工作区行
 *   统一 `workspace not found`（阻断-C：越界写拒绝，且在删除 installations 之前校验）；
 * - 只读红线（阻断-A）：团队全局工作区 + developer 的一切写操作拒绝
 *   `global workspace is read-only`。
 *
 * 夹具说明：团队全局工作区的 GitHubAccount 由团队 admin 维护，没有可用的 App OAuth
 * （需真实 GitHub App 安装回调），因此与 workspace.test.ts 的 T-WS-ISO3/4 一致，用
 * `MONGODB_URI` 直插 `githubaccounts` + `githubinstallations`，字段与模型保持一致。
 *
 * 依赖：agent-api 就绪 + `INTERNAL_API_TOKEN`（造 team 租户/成员/前台用户）+
 * `MONGODB_URI`（直插夹具与落库断言）。缺 `MONGODB_URI` 时用例在运行时跳过
 * （vitest 4 的 `list` 会隐藏静态 `skipIf` 用例，为满足「可被 `npx vitest list` 枚举」
 * 改用 `ctx.skip()`，运行期语义与 workspace.test.ts 的
 * `it.skipIf(!process.env.MONGODB_URI)` 等价）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createFrontUser, type FrontUser } from '../support/front-users.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const AGENT_API_BASE = API_URL.replace(/\/graphql\/?$/, '');
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

const GITHUB_ACCOUNTS = `
  query TeamGithubAccounts {
    githubAccounts { id githubUserId githubLogin workspaceId }
  }
`;

const COMMIT_SETTINGS = `
  query TeamCommitSettings {
    commitSettings {
      committerType customName customEmail commitWithBot
    }
  }
`;

const UPDATE_COMMIT_SETTINGS = `
  mutation TeamUpdateCommitSettings($input: CommitSettingsInput!) {
    updateCommitSettings(input: $input) {
      committerType customName customEmail commitWithBot
    }
  }
`;

const UNBIND_GITHUB_ACCOUNT = `
  mutation TeamUnbindGitHubAccount($accountId: ID!) {
    unbindGitHubAccount(accountId: $accountId)
  }
`;

const CREATE_TENANT_WORKSPACE = `
  mutation TeamCreateTenantWorkspace($name: String!) {
    createTenantWorkspace(name: $name) {
      id name type memberCount myRole readOnly
      tenant { id type }
    }
  }
`;

const ADD_TENANT_WORKSPACE_MEMBER = `
  mutation TeamAddTenantWorkspaceMember($workspaceId: ID!, $userId: ID!) {
    addTenantWorkspaceMember(workspaceId: $workspaceId, userId: $userId) {
      id memberCount
    }
  }
`;

type GqlResult = { data?: any; errors?: Array<{ message: string }> };

describe('多租户二期：团队工作区 GitHub 共享绑定（T-GH-WS）', () => {
  let admin: FrontUser;
  let developer: FrontUser;
  let teamId = '';
  let teamGlobalId = '';
  let normalWorkspaceId = '';

  let accountId = '';
  let accountObjectId: mongoose.Types.ObjectId;
  let githubUserId = 0;
  let installationId = 0;
  let githubLogin = '';

  async function gqlCtx(
    query: string,
    variables: Record<string, unknown> | undefined,
    token: string,
    workspaceId?: string,
  ): Promise<GqlResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (workspaceId) headers['x-workspace-id'] = workspaceId;
    const res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as GqlResult;
  }

  async function internalJson(
    path: string,
    method: 'POST',
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const token = process.env.INTERNAL_API_TOKEN;
    if (!token) throw new Error('T-GH-WS requires INTERNAL_API_TOKEN');
    const res = await fetch(`${AGENT_API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 保留原始文本便于排查
    }
    return { status: res.status, body: parsed };
  }

  async function mongoDb(): Promise<mongoose.mongo.Db | null> {
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
    return mongoose.connection.db ?? null;
  }

  beforeAll(async () => {
    // 缺 MONGODB_URI 时整套用例 skip（夹具无法直插），仍可在 list 中枚举用例名
    if (!HAS_MONGO) return;

    admin = await createFrontUser();
    developer = await createFrontUser();

    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

    // 团队租户 + 全局工作区（internal 创建即自动开通 global 工作区）
    const team = await internalJson('/internal/tenants', 'POST', {
      name: `ghws-${suffix}`.slice(0, 60),
    });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.tenant.id;
    teamGlobalId = team.body.globalWorkspace.id;

    for (const [username, role] of [
      [admin.username, 'admin'],
      [developer.username, 'developer'],
    ] as const) {
      const added = await internalJson(`/internal/tenants/${teamId}/members`, 'POST', {
        username,
        role,
      });
      expect([200, 201], JSON.stringify(added.body)).toContain(added.status);
    }

    // admin 在团队全局工作区创建普通工作区，并把 developer 加入（normal 上下文需 workspacemembers）
    const created = await gqlCtx(
      CREATE_TENANT_WORKSPACE,
      { name: `ghws-normal-${suffix}` },
      admin.token,
      teamGlobalId,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    normalWorkspaceId = created.data.createTenantWorkspace.id;

    const joined = await gqlCtx(
      ADD_TENANT_WORKSPACE_MEMBER,
      { workspaceId: normalWorkspaceId, userId: developer.userId },
      admin.token,
      teamGlobalId,
    );
    expect(joined.errors, JSON.stringify(joined.errors)).toBeUndefined();

    // 团队全局工作区的 GitHubAccount 共享绑定（无 App OAuth，直插夹具；字段与模型一致）
    const db = await mongoDb();
    expect(db, 'T-GH-WS 需要 MONGODB_URI').not.toBeNull();
    accountObjectId = new mongoose.Types.ObjectId();
    accountId = accountObjectId.toString();
    installationId = 900000 + Math.floor(Math.random() * 100000);
    githubLogin = `ghws-${suffix}`;
    const now = new Date();

    await db!.collection('githubaccounts').insertOne({
      _id: accountObjectId,
      userId: admin.userId,
      tenantId: teamId,
      // 共享行归属团队全局工作区（String 口径 = workspace._id.toString()）
      workspaceId: teamGlobalId,
      githubUserId: (githubUserId = 800000 + Math.floor(Math.random() * 100000)),
      githubLogin,
      githubAvatarUrl: null,
      accessToken: 'gho_ghws_test_token',
      tokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await db!.collection('githubinstallations').insertOne({
      accountId: accountObjectId,
      installationId,
      accountLogin: githubLogin,
      accountType: 'User',
      repos: [],
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    const db = await mongoDb().catch(() => null);
    if (!db) return;
    if (accountObjectId) {
      await db.collection('githubaccounts').deleteOne({ _id: accountObjectId });
      await db.collection('githubinstallations').deleteMany({ accountId: accountObjectId });
    }
    if (installationId) {
      await db.collection('githubinstallations').deleteMany({ installationId });
    }
    // 本套件写入的 commit 设置（按工作区单行）
    const workspaceIds = [normalWorkspaceId, teamGlobalId].filter(Boolean);
    if (workspaceIds.length > 0) {
      await db.collection('user_commit_settings').deleteMany({ workspaceId: { $in: workspaceIds } });
    }
  });

  it(
    'T-GH-WS1（阻断-B，MONGODB_URI 直插夹具）：developer 在普通工作区可见团队全局共享绑定，并可将其选为提交人',
    async (ctx) => {
      if (!HAS_MONGO) {
        ctx.skip();
        return;
      }
      // 读口径：当前工作区 ∪ 本租户全局工作区
      const visible = await gqlCtx(GITHUB_ACCOUNTS, undefined, developer.token, normalWorkspaceId);
      expect(visible.errors, JSON.stringify(visible.errors)).toBeUndefined();
      const shared = visible.data.githubAccounts.find((row: { id: string }) => row.id === accountId);
      expect(shared, '普通工作区应读到团队全局工作区的共享 GitHubAccount').toBeDefined();
      expect(shared).toMatchObject({ id: accountId, workspaceId: teamGlobalId, githubLogin });

      // Commit 设置已改为成员级：与工作区无关，保存后同一份在任意工作区可读
      const saved = await gqlCtx(
        UPDATE_COMMIT_SETTINGS,
        { input: { committerType: 'CUSTOM', customName: 'Dev Committer', customEmail: 'dev@example.com' } },
        developer.token,
        normalWorkspaceId,
      );
      expect(saved.errors, JSON.stringify(saved.errors)).toBeUndefined();
      expect(saved.data.updateCommitSettings).toEqual({
        committerType: 'CUSTOM',
        customName: 'Dev Committer',
        customEmail: 'dev@example.com',
        commitWithBot: false,
      });

      const readbackInGlobal = await gqlCtx(COMMIT_SETTINGS, undefined, developer.token, teamGlobalId);
      expect(readbackInGlobal.errors, JSON.stringify(readbackInGlobal.errors)).toBeUndefined();
      expect(readbackInGlobal.data.commitSettings).toMatchObject({ customName: 'Dev Committer' });
    },
  );

  it(
    'T-GH-WS2（阻断-C，MONGODB_URI 直插夹具）：developer 在普通工作区解绑共享行被拒（workspace not found），绑定与安装数据保留',
    async (ctx) => {
      if (!HAS_MONGO) {
        ctx.skip();
        return;
      }
      const unbound = await gqlCtx(UNBIND_GITHUB_ACCOUNT, { accountId }, developer.token, normalWorkspaceId);
      // 共享读命中全局行 → 越界写统一 Not found（不泄露存在性、不半删除）
      expect(unbound.errors?.[0]?.message).toBe('workspace not found');
      expect(unbound.data).toBeNull();

      // 绑定仍可见（未假成功）
      const stillVisible = await gqlCtx(GITHUB_ACCOUNTS, undefined, developer.token, normalWorkspaceId);
      expect(stillVisible.errors, JSON.stringify(stillVisible.errors)).toBeUndefined();
      expect(stillVisible.data.githubAccounts.some((row: { id: string }) => row.id === accountId)).toBe(true);

      // 落库断言：account 与 installations 均未被清理
      const db = await mongoDb();
      expect(db).not.toBeNull();
      expect(await db!.collection('githubaccounts').countDocuments({ _id: accountObjectId })).toBe(1);
      expect(await db!.collection('githubinstallations').countDocuments({ accountId: accountObjectId })).toBe(1);
    },
  );

  it(
    'T-GH-WS3（阻断-A，MONGODB_URI 直插夹具）：developer 在团队全局工作区只读（global workspace is read-only）',
    async (ctx) => {
      if (!HAS_MONGO) {
        ctx.skip();
        return;
      }
      // 只读仅限写：共享绑定仍可读
      const visible = await gqlCtx(GITHUB_ACCOUNTS, undefined, developer.token, teamGlobalId);
      expect(visible.errors, JSON.stringify(visible.errors)).toBeUndefined();
      expect(visible.data.githubAccounts.some((row: { id: string }) => row.id === accountId)).toBe(true);

      const settingsView = await gqlCtx(COMMIT_SETTINGS, undefined, developer.token, teamGlobalId);
      expect(settingsView.errors, JSON.stringify(settingsView.errors)).toBeUndefined();
      expect(settingsView.data.commitSettings).not.toHaveProperty('readOnly');

      // Commit 设置是成员属性：即使在只读工作区，developer 也可保存自己的提交人
      const settingsWrite = await gqlCtx(
        UPDATE_COMMIT_SETTINGS,
        { input: { committerType: 'CUSTOM', customName: 'Readonly Dev', customEmail: 'ro@example.com' } },
        developer.token,
        teamGlobalId,
      );
      expect(settingsWrite.errors, JSON.stringify(settingsWrite.errors)).toBeUndefined();
      expect(settingsWrite.data.updateCommitSettings).toMatchObject({ customName: 'Readonly Dev' });

      // 写 2：unbindGitHubAccount 原样透出只读红线文案
      const unbind = await gqlCtx(UNBIND_GITHUB_ACCOUNT, { accountId }, developer.token, teamGlobalId);
      expect(unbind.errors?.[0]?.message).toBe('global workspace is read-only');

      // 绑定仍在
      const db = await mongoDb();
      expect(await db!.collection('githubaccounts').countDocuments({ _id: accountObjectId })).toBe(1);
    },
  );

  it(
    'T-GH-WS4（MONGODB_URI 直插夹具）：admin 在团队全局工作区可更新 commit settings（管理员可写全局）',
    async (ctx) => {
      if (!HAS_MONGO) {
        ctx.skip();
        return;
      }
      const saved = await gqlCtx(
        UPDATE_COMMIT_SETTINGS,
        { input: { committerType: 'CUSTOM', customName: 'Admin Committer', customEmail: 'admin@example.com' } },
        admin.token,
        teamGlobalId,
      );
      expect(saved.errors, JSON.stringify(saved.errors)).toBeUndefined();
      expect(saved.data.updateCommitSettings).toEqual({
        committerType: 'CUSTOM',
        customName: 'Admin Committer',
        customEmail: 'admin@example.com',
        commitWithBot: false,
      });

      const readback = await gqlCtx(COMMIT_SETTINGS, undefined, admin.token, teamGlobalId);
      expect(readback.errors, JSON.stringify(readback.errors)).toBeUndefined();
      expect(readback.data.commitSettings).toMatchObject({ customName: 'Admin Committer' });
    },
  );

  it(
    'T-GH-WS5（阻断-I，MONGODB_URI 直插夹具）：同账号双工作区解绑全局行保留 normal 绑定安装数据',
    async (ctx) => {
      if (!HAS_MONGO) ctx.skip();
      const db = await mongoDb();
      const normalAccountId = new mongoose.Types.ObjectId();
      const now = new Date();
      await db!.collection('githubaccounts').insertOne({
        _id: normalAccountId,
        userId: developer.userId,
        tenantId: teamId,
        workspaceId: normalWorkspaceId,
        githubUserId,
        githubLogin,
        githubAvatarUrl: null,
        accessToken: 'gho_ghws_test_token_normal',
        tokenExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      });

      // admin 在团队全局上下文解绑全局行：normal 行仍存活，不得卸载 App/删除安装数据
      const unbound = await gqlCtx(UNBIND_GITHUB_ACCOUNT, { accountId }, admin.token, teamGlobalId);
      expect(unbound.errors, JSON.stringify(unbound.errors)).toBeUndefined();
      expect(unbound.data.unbindGitHubAccount).toBe(true);

      expect(
        await db!.collection('githubaccounts').countDocuments({ _id: normalAccountId }),
      ).toBe(1);
      expect(
        await db!.collection('githubaccounts').countDocuments({ _id: accountObjectId }),
      ).toBe(0);
      const installation = await db!
        .collection('githubinstallations')
        .findOne({ installationId });
      expect(installation, '共享安装数据必须保留').not.toBeNull();
      expect(String(installation?.accountId)).toBe(String(normalAccountId));

      // 清理，避免影响其它套件/重跑
      await db!.collection('githubaccounts').deleteOne({ _id: normalAccountId });
      await db!.collection('githubinstallations').deleteOne({ installationId });
    },
  );
});
