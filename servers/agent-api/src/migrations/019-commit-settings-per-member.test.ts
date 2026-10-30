import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './019-commit-settings-per-member.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-019-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;
const settings = () => db().collection('user_commit_settings');

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
  alice: mongoose.Types.ObjectId;
  bob: mongoose.Types.ObjectId;
  carol: mongoose.Types.ObjectId;
  personalA: mongoose.Types.ObjectId;
  personalB: mongoose.Types.ObjectId;
  team: mongoose.Types.ObjectId;
  teamWorkspaceId: mongoose.Types.ObjectId;
  personalWorkspaceId: mongoose.Types.ObjectId;
  aliceAccountId: mongoose.Types.ObjectId;
  bobAccountId: mongoose.Types.ObjectId;
}

async function seed(): Promise<Fixture> {
  const alice = new mongoose.Types.ObjectId();
  const bob = new mongoose.Types.ObjectId();
  const carol = new mongoose.Types.ObjectId();
  // personal 租户 _id 复用 owner userId（多租户一期）
  const personalA = alice;
  const personalB = bob;
  const team = new mongoose.Types.ObjectId();

  await db().collection('tenants').insertMany([
    { _id: personalA, name: 'alice', type: 'personal' },
    { _id: personalB, name: 'bob', type: 'personal' },
    { _id: team, name: 'team-a', type: 'team' },
  ]);
  await db().collection('users').insertMany([
    { _id: alice, username: 'alice', tenantId: personalA },
    { _id: bob, username: 'bob', tenantId: personalB },
    { _id: carol, username: 'carol', tenantId: team },
  ]);

  const teamWorkspaceId = new mongoose.Types.ObjectId();
  const personalWorkspaceId = new mongoose.Types.ObjectId();
  await db().collection('workspaces').insertMany([
    // workspaces.type 只有 global/normal；personal/team 是「租户」类型，归属重键按租户判定
    { _id: personalWorkspaceId, name: '全局工作区', type: 'global', tenantId: personalA },
    { _id: teamWorkspaceId, name: '全局工作区', type: 'global', tenantId: team },
  ]);

  const aliceAccountId = new mongoose.Types.ObjectId();
  const bobAccountId = new mongoose.Types.ObjectId();
  await db().collection('githubaccounts').insertMany([
    {
      _id: aliceAccountId,
      userId: String(alice),
      tenantId: String(personalA),
      workspaceId: String(personalWorkspaceId),
      githubUserId: 1001,
      githubLogin: 'alice-gh',
    },
    {
      _id: bobAccountId,
      userId: String(bob),
      tenantId: String(personalB),
      workspaceId: String(teamWorkspaceId),
      githubUserId: 2002,
      githubLogin: 'bob-gh',
    },
  ]);

  return {
    alice,
    bob,
    carol,
    personalA,
    personalB,
    team,
    teamWorkspaceId,
    personalWorkspaceId,
    aliceAccountId,
    bobAccountId,
  };
}

async function createLegacyWorkspaceUniqueIndex(): Promise<void> {
  await settings().createIndex({ workspaceId: 1 }, { unique: true, name: 'uniq_workspace_commit_setting' });
}

describe('migration 019 commit settings per member', () => {
  it('T-MIG-CS1: github_account → custom 等价转换（署名逐字一致）', async () => {
    const f = await seed();
    await settings().insertOne({
      userId: String(f.alice),
      tenantId: String(f.personalA),
      workspaceId: String(f.personalWorkspaceId),
      committerMode: 'human_only',
      committerType: 'github_account',
      githubAccountId: f.aliceAccountId,
    });

    const result = await migration.convertGithubAccounts();
    expect(result).toEqual({ converted: 1, unsetFromMissingAccount: 0 });

    const row = await settings().findOne({});
    expect(row?.committerType).toBe('custom');
    expect(row?.customName).toBe('alice-gh');
    expect(row?.customEmail).toBe('1001+alice-gh@users.noreply.github.com');
    expect(row?.githubAccountId).toBeUndefined();
  });

  it('T-MIG-CS2: 帐号缺失 → unset 并清空自定义字段', async () => {
    const f = await seed();
    await settings().insertOne({
      userId: String(f.alice),
      tenantId: String(f.personalA),
      workspaceId: String(f.personalWorkspaceId),
      committerType: 'github_account',
      githubAccountId: new mongoose.Types.ObjectId(),
      customName: 'stale',
      customEmail: 'stale@example.com',
    });

    const result = await migration.convertGithubAccounts();
    expect(result).toEqual({ converted: 0, unsetFromMissingAccount: 1 });

    const row = await settings().findOne({});
    expect(row?.committerType).toBe('unset');
    expect(row?.customName).toBeNull();
    expect(row?.customEmail).toBeNull();
  });

  it('T-MIG-CS3: personal → tenantId（=owner userId），team → 行内 userId', async () => {
    const f = await seed();
    await settings().insertMany([
      {
        userId: String(f.alice),
        tenantId: String(f.personalA),
        workspaceId: String(f.personalWorkspaceId),
        committerType: 'custom',
        customName: 'Alice',
        customEmail: 'alice@example.com',
      },
      {
        // 团队工作区行：最近编辑人为 carol，owner 应为 carol
        userId: String(f.carol),
        tenantId: String(f.team),
        workspaceId: String(f.teamWorkspaceId),
        committerType: 'custom',
        customName: 'Carol',
        customEmail: 'carol@example.com',
      },
    ]);

    const result = await migration.rekeyOwners();
    // personal 行 owner=tenantId=alice 与行内 userId 相同；team 行 owner=行内 userId=carol，
    // 两行 userId 均无需改写，重键的实际效果是移除 workspaceId 维度。
    expect(result.rekeyed).toBe(0);
    expect(result.merged).toBe(0);

    const aliceRow = await settings().findOne({ customName: 'Alice' });
    const carolRow = await settings().findOne({ customName: 'Carol' });
    expect(aliceRow?.userId).toBe(String(f.alice));
    expect(carolRow?.userId).toBe(String(f.carol));

    // workspaceId 维度在索引切换后由字段清洗移除
    await migration.cleanFields();
    const cleanedAlice = await settings().findOne({ customName: 'Alice' });
    const cleanedCarol = await settings().findOne({ customName: 'Carol' });
    expect(cleanedAlice?.workspaceId).toBeUndefined();
    expect(cleanedCarol?.workspaceId).toBeUndefined();
  });

  it('T-MIG-CS3b: team 工作区行归属最近编辑人（userId 与 owner 不同时改写）', async () => {
    const f = await seed();
    await settings().insertOne({
      userId: String(f.carol),
      tenantId: String(f.team),
      workspaceId: String(f.teamWorkspaceId),
      committerType: 'custom',
      customName: 'Carol',
      customEmail: 'carol@example.com',
    });

    await migration.rekeyOwners();
    const row = await settings().findOne({});
    expect(row?.userId).toBe(String(f.carol));
  });

  it('T-MIG-CS3c: personal 租户行按租户归属（行内 userId 非 owner 时改写为 tenantId）', async () => {
    const f = await seed();
    const editor = new mongoose.Types.ObjectId();
    await settings().insertOne({
      userId: String(editor),
      tenantId: String(f.personalA),
      workspaceId: String(f.personalWorkspaceId),
      committerType: 'custom',
      customName: 'Alice Personal',
      customEmail: 'alice-personal@example.com',
    });

    const result = await migration.rekeyOwners();
    expect(result.rekeyed).toBe(1);

    const row = await settings().findOne({ customName: 'Alice Personal' });
    // personal 租户 _id 复用 owner userId：owner = tenantId = alice
    expect(row?.userId).toBe(String(f.personalA));
  });

  it('T-MIG-CS4: 同 owner 碰撞合并（保留最新非 unset，其余删除并计数）', async () => {
    const f = await seed();
    await settings().insertMany([
      {
        userId: String(f.alice),
        tenantId: String(f.personalA),
        workspaceId: String(f.personalWorkspaceId),
        committerType: 'custom',
        customName: 'Old',
        customEmail: 'old@example.com',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        userId: String(f.alice),
        tenantId: String(f.personalA),
        workspaceId: '507f1f77bcf86cd7994390aa',
        committerType: 'unset',
        customName: null,
        customEmail: null,
        updatedAt: new Date('2026-03-01T00:00:00Z'),
      },
      {
        // 同一 personal 工作区的另一行（模拟历史复制批次）
        userId: String(f.alice),
        tenantId: String(f.personalA),
        workspaceId: String(f.personalWorkspaceId).replace(/^./, 'f'),
        committerType: 'custom',
        customName: 'Newest',
        customEmail: 'newest@example.com',
        updatedAt: new Date('2026-02-01T00:00:00Z'),
      },
    ]);

    const result = await migration.rekeyOwners();
    expect(result.merged).toBe(2);

    const rows = await settings().find({ userId: String(f.alice) }).toArray();
    expect(rows).toHaveLength(1);
    // 「最新非 unset」= Newest（非 unset 优先于更新的 unset）
    expect(rows[0].customName).toBe('Newest');

    await migration.cleanFields();
    const cleaned = await settings().findOne({});
    expect(cleaned?.workspaceId).toBeUndefined();
  });

  it('T-MIG-CS5: 索引先建后删（uniq_user_commit_setting 存在且 unique，旧索引已删）', async () => {
    const f = await seed();
    await settings().insertOne({
      userId: String(f.alice),
      tenantId: String(f.personalA),
      workspaceId: String(f.personalWorkspaceId),
      committerType: 'custom',
      customName: 'Alice',
      customEmail: 'alice@example.com',
    });
    await createLegacyWorkspaceUniqueIndex();

    await migration.switchIndexes();

    const indexes = await settings().indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));
    expect(byName.get('uniq_user_commit_setting')?.unique).toBe(true);
    expect(byName.get('uniq_workspace_commit_setting')).toBeUndefined();
    expect(byName.get('workspaceId_1')).toBeUndefined();
  });

  it('T-MIG-CS6: 幂等重入（跑两次不报错、残留计数为 0、无重复行）', async () => {
    const f = await seed();
    await settings().insertMany([
      {
        userId: String(f.alice),
        tenantId: String(f.personalA),
        workspaceId: String(f.personalWorkspaceId),
        committerMode: 'agent_only',
        committerType: 'github_account',
        githubAccountId: f.aliceAccountId,
      },
      {
        userId: String(f.bob),
        tenantId: String(f.personalB),
        workspaceId: String(f.teamWorkspaceId),
        committerType: 'custom',
        customName: 'Bob',
        customEmail: 'bob@example.com',
      },
    ]);
    await createLegacyWorkspaceUniqueIndex();

    await migration.run();
    await expect(migration.run()).resolves.toBeUndefined();

    const rows = await settings().find({}).toArray();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.committerType !== 'github_account')).toBe(true);
    expect(rows.every((row) => row.workspaceId === undefined)).toBe(true);
    expect(rows.every((row) => row.committerMode === undefined)).toBe(true);
    // tenantId 按 owner 成员刷新
    expect(rows.find((row) => row.userId === String(f.alice))?.tenantId).toBe(String(f.personalA));
    expect(rows.find((row) => row.userId === String(f.bob))?.tenantId).toBe(String(f.personalB));
  });
});
