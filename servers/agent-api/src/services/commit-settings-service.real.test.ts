import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { UserCommitSetting } from '../models/user-commit-setting.js';
import { User } from '../models/user.js';
import { Tenant } from '../models/tenant.js';
import { Workspace } from '../models/workspace.js';
import { TenantMember } from '../models/tenant-member.js';
import { GitHubAccount } from '../models/github-account.js';
import { commitSettingsService } from './commit-settings-service.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';
import * as migration019 from '../migrations/019-commit-settings-per-member.js';

/**
 * 真库回归（mongodb-memory-server + 真实 Mongoose 插件 + 真实 service）：
 * 成员级提交人设置必须**跨工作区上下文**保持同一份——这是纯 mock 单测无法覆盖的
 * 「ALS tenantId 注入」路径（见 `models/user-commit-setting.ts` 注释与 T-ISO 豁免）。
 */
let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-commit-settings-real-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;

beforeEach(async () => {
  const collections = await db().collections();
  await Promise.all(
    collections.map(async (collection) => {
      await collection.deleteMany({});
      if (collection.collectionName !== 'system.indexes') {
        await collection.dropIndexes().catch(() => undefined);
      }
    }),
  );
});

interface Fixture {
  userId: string;
  personalTenantId: string;
  teamTenantId: string;
  personalContext: WorkspaceContext;
  teamContext: WorkspaceContext;
}

async function seed(): Promise<Fixture> {
  const userId = new mongoose.Types.ObjectId();
  const personalTenantId = userId; // personal 租户 _id 复用 owner userId
  const teamTenantId = new mongoose.Types.ObjectId();

  await Tenant.create([
    { _id: personalTenantId, name: `personal-${userId}`, type: 'personal' },
    { _id: teamTenantId, name: `team-${userId}`, type: 'team' },
  ]);
  // 成员归属租户恒为 personal（团队只通过 tenantmembers / 工作区成员参与）
  await User.create({
    _id: userId,
    username: `u${String(userId).slice(-12)}`,
    passwordHash: 'test-hash',
    tenantId: personalTenantId,
  });

  const personalWorkspaceId = new mongoose.Types.ObjectId();
  const teamWorkspaceId = new mongoose.Types.ObjectId();
  await Workspace.create([
    { _id: personalWorkspaceId, tenantId: personalTenantId, name: '全局工作区', type: 'global' },
    { _id: teamWorkspaceId, tenantId: teamTenantId, name: '全局工作区', type: 'global' },
  ]);
  await TenantMember.create({ tenantId: teamTenantId, userId, role: 'developer' });
  await GitHubAccount.create({
    userId: String(userId),
    tenantId: String(personalTenantId),
    workspaceId: String(personalWorkspaceId),
    githubUserId: 1001,
    githubLogin: 'alice-gh',
    accessToken: 'encrypted-token',
  });

  return {
    userId: String(userId),
    personalTenantId: String(personalTenantId),
    teamTenantId: String(teamTenantId),
    personalContext: {
      id: String(personalWorkspaceId),
      tenantId: String(personalTenantId),
      type: 'global',
      role: 'admin',
      readOnly: false,
      globalWorkspaceId: String(personalWorkspaceId),
    },
    teamContext: {
      id: String(teamWorkspaceId),
      tenantId: String(teamTenantId),
      type: 'global',
      role: 'developer',
      readOnly: false,
      globalWorkspaceId: String(teamWorkspaceId),
    },
  };
}

const CUSTOM = {
  committerType: 'CUSTOM' as const,
  customName: 'Alice',
  customEmail: 'alice@example.com',
};

describe('commit settings 成员级跨工作区（真库，T-CS-R*）', () => {
  it('T-CS-R1: 团队工作区保存 → 个人工作区读取为同一份（不按上下文租户隔离）', async () => {
    const f = await seed();

    const saved = await runWithWorkspace(f.teamContext, () =>
      commitSettingsService.updateCommitSettings(f.userId, CUSTOM),
    );
    expect(saved).toEqual({
      committerType: 'CUSTOM',
      customName: 'Alice',
      customEmail: 'alice@example.com',
    });

    const personalView = await runWithWorkspace(f.personalContext, () =>
      commitSettingsService.getCommitSettings(f.userId),
    );
    expect(personalView).toEqual(saved);

    // tenantId 留档 = 成员归属租户（personal），而非保存时的工作区租户（team）
    const row = await UserCommitSetting.findOne({ userId: f.userId }).lean();
    expect(row?.tenantId).toBe(f.personalTenantId);
  });

  it('T-CS-R2: 个人工作区保存 → 团队工作区二次保存覆盖（唯一行、不撞键、不静默丢失）', async () => {
    const f = await seed();

    await runWithWorkspace(f.personalContext, () =>
      commitSettingsService.updateCommitSettings(f.userId, {
        committerType: 'CUSTOM',
        customName: 'First',
        customEmail: 'first@example.com',
      }),
    );

    // 跨上下文二次保存：若仍按上下文 tenantId 过滤会 upsert 撞 uniq_user_commit_setting（E11000）
    // 且回读落空 → mutation 静默返回 UNSET。这里必须返回覆盖后的真实值。
    const second = await runWithWorkspace(f.teamContext, () =>
      commitSettingsService.updateCommitSettings(f.userId, {
        committerType: 'CUSTOM',
        customName: 'Second',
        customEmail: 'second@example.com',
      }),
    );
    expect(second).toEqual({
      committerType: 'CUSTOM',
      customName: 'Second',
      customEmail: 'second@example.com',
    });

    expect(await UserCommitSetting.countDocuments({ userId: f.userId })).toBe(1);

    const personalView = await runWithWorkspace(f.personalContext, () =>
      commitSettingsService.getCommitSettings(f.userId),
    );
    expect(personalView).toEqual(second);
  });

  it('T-CS-R3: 团队工作区保存 → 无 ALS 上下文（Issue 触发链）可解析 worktree 提交人', async () => {
    const f = await seed();

    await runWithWorkspace(f.teamContext, () =>
      commitSettingsService.updateCommitSettings(f.userId, CUSTOM),
    );

    // webhook / workflow 引擎链路没有 ALS store：必须仍能命中同一行
    const committer = await commitSettingsService.resolveWorktreeCommitter(f.userId);
    expect(committer).toEqual({ name: 'Alice', email: 'alice@example.com' });
  });

  it('T-CS-R4: 迁移 019 存量行（workspaceId 维度）在团队上下文仍可读，且署名逐字一致', async () => {
    const f = await seed();

    // 迁移前形态：workspaceId 键 + github_account 类型
    const account = await GitHubAccount.findOne({ userId: f.userId }).lean();
    await db()
      .collection('user_commit_settings')
      .insertOne({
        userId: f.userId,
        tenantId: f.personalTenantId,
        workspaceId: f.teamContext.id,
        committerMode: 'human_only',
        committerType: 'github_account',
        githubAccountId: account!._id,
      });

    await migration019.run();

    const teamView = await runWithWorkspace(f.teamContext, () =>
      commitSettingsService.getCommitSettings(f.userId),
    );
    expect(teamView).toEqual({
      committerType: 'CUSTOM',
      customName: 'alice-gh',
      customEmail: '1001+alice-gh@users.noreply.github.com',
    });

    const personalView = await runWithWorkspace(f.personalContext, () =>
      commitSettingsService.getCommitSettings(f.userId),
    );
    expect(personalView).toEqual(teamView);

    // 迁移后残留清理
    const raw = await db().collection('user_commit_settings').findOne({ userId: f.userId });
    expect(raw?.workspaceId).toBeUndefined();
    expect(raw?.committerMode).toBeUndefined();
  });
});
