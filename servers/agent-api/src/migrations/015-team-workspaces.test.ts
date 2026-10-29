import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './015-team-workspaces.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-015-test'));
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
      // 清掉上一轮迁移建立的索引（真库连接复用同一 DB）
      if (collection.collectionName !== 'system.indexes') {
        await collection.dropIndexes().catch(() => undefined);
      }
    }),
  );
});

interface Fixture {
  userIds: mongoose.Types.ObjectId[];
  tenantIds: mongoose.Types.ObjectId[];
}

async function seed(): Promise<Fixture> {
  const personalA = new mongoose.Types.ObjectId();
  const personalB = new mongoose.Types.ObjectId();
  const team = new mongoose.Types.ObjectId();
  await db().collection('tenants').insertMany([
    { _id: personalA, name: 'alice', type: 'personal' },
    { _id: personalB, name: 'bob', type: 'personal' },
    { _id: team, name: 'team-a', type: 'team' },
  ]);
  const userA = new mongoose.Types.ObjectId();
  const userB = new mongoose.Types.ObjectId();
  const userC = new mongoose.Types.ObjectId();
  await db().collection('users').insertMany([
    { _id: userA, username: 'alice', tenantId: personalA },
    { _id: userB, username: 'bob', tenantId: personalB },
    { _id: userC, username: 'carol', tenantId: team },
  ]);
  await db().collection('tenantmembers').insertMany([
    // 团队租户已有一名 admin（迁移不覆盖既有角色）
    { tenantId: team, userId: userC, role: 'admin', createdBy: 'seed' },
  ]);

  const controllerId = new mongoose.Types.ObjectId();
  const keyId = new mongoose.Types.ObjectId();
  for (const [userId, tenantId] of [[userA, personalA], [userB, personalB]] as const) {
    await db().collection('sessions').insertOne({
      userId,
      tenantId,
      controllerId,
      controllerName: 'c',
      acpServerType: 'opencode',
    });
    await db().collection('controllers').insertOne({ userId, tenantId, keyId, hostname: 'h', type: 'local', version: '1' });
    await db().collection('controllerkeys').insertOne({ userId, tenantId, name: 'k', type: 'local', keyHash: 'h', keyPrefix: 'p' });
    await db().collection('cloudhosts').insertOne({ userId, tenantId, name: 'host', controllerId, keyId, tenantIdFrom: 'x' });
    await db().collection('configuredworkflows').insertOne({ userId, tenantId, controllerId, name: 'cw', nodes: [] });
    await db().collection('workflowinstances').insertOne({ userId, tenantId, controllerId, workspaceId: new mongoose.Types.ObjectId(), name: 'wi', nodes: [] });
    await db().collection('workflowtemplates').insertOne({ userId, tenantId, name: 'wt', nodes: [] });
    await db().collection('githubaccounts').insertOne({ userId: String(userId), tenantId: String(tenantId), githubUserId: 1, githubLogin: 'octo', accessToken: 'x' });
    await db().collection('user_commit_settings').insertOne({ userId: String(userId), tenantId: String(tenantId), committerMode: 'unset' });
  }
  // 覆盖 cloudhosts 第二个 userId/tenantId 字段（上面误写的 tenantIdFrom 不影响）
  await db().collection('workflowtemplates').insertOne({
    userId: null,
    tenantId: null,
    name: '内置模板',
    isBuiltin: true,
    nodes: [],
  });

  // providers/models 存量共享行（无 tenantId/workspaceId；含 scope 缺失行）
  const providerUser = await db().collection('providers').insertOne({
    name: 'openai-a',
    type: 'OpenAI',
    endpoint: 'https://api.example.com',
    credentialType: 'api_key',
    encryptedCredential: { iv: 'i', ciphertext: 'c', tag: 't' },
    scope: 'user',
  });
  const providerNoScope = await db().collection('providers').insertOne({
    name: 'no-scope',
    type: 'OpenAI',
    endpoint: 'https://api.example.com',
    credentialType: 'api_key',
    encryptedCredential: { iv: 'i', ciphertext: 'c', tag: 't' },
  });
  await db().collection('providers').insertOne({
    name: 'builtin-global',
    type: 'OpenAI',
    endpoint: 'https://api.example.com',
    credentialType: 'api_key',
    encryptedCredential: { iv: 'i', ciphertext: 'c', tag: 't' },
    scope: 'global',
  });
  await db().collection('models').insertMany([
    { providerId: providerUser.insertedId, name: 'gpt-4', scope: 'user' },
    { providerId: providerNoScope.insertedId, name: 'gpt-3.5', scope: 'user' },
  ]);
  // 旧索引
  await db()
    .collection('providers')
    .createIndex({ scope: 1, name: 1 }, { unique: true, name: 'scope_1_name_1' });
  await db()
    .collection('user_commit_settings')
    .createIndex({ userId: 1 }, { unique: true, name: 'uniq_user_commit_setting' });
  await db()
    .collection('githubaccounts')
    .createIndex(
      { tenantId: 1, userId: 1, githubUserId: 1 },
      { unique: true, name: 'tenantId_1_userId_1_githubUserId_1' },
    );

  return { userIds: [userA, userB, userC], tenantIds: [personalA, personalB, team] };
}

describe('migration 015-team-workspaces（T-MIG15）', () => {
  it('T-MIG15a/b: 每租户恰一个全局工作区、tenantmembers 回填 personal 恒 admin、11 集合回填', async () => {
    const fixture = await seed();
    await migration.run();

    const globalRows = await db()
      .collection('workspaces')
      .find({ type: 'global' })
      .toArray();
    expect(globalRows).toHaveLength(3);
    expect(new Set(globalRows.map((row) => String(row.tenantId)))).toEqual(
      new Set(fixture.tenantIds.map(String)),
    );

    const members = await db().collection('tenantmembers').find({}).toArray();
    const personalA = members.find((row) => String(row.tenantId) === String(fixture.tenantIds[0]));
    expect(personalA).toMatchObject({ role: 'admin', createdBy: 'migration' });
    expect(members.some((row) => row.role === undefined)).toBe(false);
    // 团队已有 admin 不被覆盖
    expect(
      members.find((row) => String(row.tenantId) === String(fixture.tenantIds[2]))?.createdBy,
    ).toBe('seed');

    const globalByTenant = new Map(globalRows.map((row) => [String(row.tenantId), String(row._id)]));
    for (const collection of ['sessions', 'controllers', 'controllerkeys']) {
      const rows = await db().collection(collection).find({}).toArray();
      for (const row of rows) {
        expect(String(row.workspaceId)).toBe(globalByTenant.get(String(row.tenantId)));
      }
    }
    const hosts = await db().collection('cloudhosts').find({}).toArray();
    for (const row of hosts) {
      expect(String(row.resourceWorkspaceId)).toBe(globalByTenant.get(String(row.tenantId)));
      expect(row.workspaceId).toBeUndefined();
    }
    for (const collection of ['workflowinstances', 'configuredworkflows']) {
      const rows = await db().collection(collection).find({}).toArray();
      for (const row of rows) {
        expect(String(row.resourceWorkspaceId)).toBe(globalByTenant.get(String(row.tenantId)));
      }
    }
    const githubRows = await db().collection('githubaccounts').find({}).toArray();
    for (const row of githubRows) {
      expect(String(row.workspaceId)).toBe(globalByTenant.get(String(row.tenantId)));
      expect(typeof row.workspaceId).toBe('string');
    }
    const templates = await db().collection('workflowtemplates').find({}).toArray();
    const builtin = templates.find((row) => row.isBuiltin);
    expect(builtin?.resourceWorkspaceId ?? null).toBeNull();
    const custom = templates.find((row) => !row.isBuiltin);
    expect(String(custom?.resourceWorkspaceId)).toBe(globalByTenant.get(String(custom?.tenantId)));
  });

  it('T-MIG15c/d/e: providers/models 按租户复制、scope 缺失行同口径、原件删除、索引切换', async () => {
    const fixture = await seed();
    await migration.run();

    // 每租户 2 条 user 域 provider（scope user + scope 缺失），global 行保留且不动
    for (const tenantId of fixture.tenantIds) {
      const copied = await db()
        .collection('providers')
        .find({ tenantId, scope: 'user' })
        .toArray();
      expect(copied.map((row) => row.name).sort()).toEqual(['no-scope', 'openai-a']);
      const global = await db().collection('workspaces').findOne({ tenantId, type: 'global' });
      expect(copied.every((row) => String(row.workspaceId) === String(global?._id))).toBe(true);
      const models = await db()
        .collection('models')
        .find({ tenantId, scope: 'user' })
        .toArray();
      expect(models.map((row) => row.name).sort()).toEqual(['gpt-3.5', 'gpt-4']);
    }
    const globals = await db().collection('providers').find({ scope: 'global' }).toArray();
    expect(globals.map((row) => row.name)).toEqual(['builtin-global']);
    expect(globals[0].workspaceId).toBeUndefined();

    // 无孤儿：scope=user 行必须有 workspaceId/tenantId
    expect(await db().collection('providers').countDocuments({ scope: 'user', workspaceId: null })).toBe(0);
    expect(await db().collection('models').countDocuments({ scope: 'user', workspaceId: null })).toBe(0);

    const providerIndexes = await db().collection('providers').indexes();
    expect(providerIndexes.some((index) => index.name === 'scope_1_name_1')).toBe(false);
    expect(providerIndexes.some((index) => index.name === 'uniq_provider_tenant_workspace_name')).toBe(true);
    expect(providerIndexes.some((index) => index.name === 'uniq_provider_global_name')).toBe(true);

    const commitIndexes = await db().collection('user_commit_settings').indexes();
    expect(commitIndexes.some((index) => index.name === 'uniq_workspace_commit_setting')).toBe(true);
    expect(commitIndexes.some((index) => index.name === 'uniq_user_commit_setting')).toBe(false);
    expect(commitIndexes.some((index) => index.name === 'userId_1')).toBe(false);
    expect(commitIndexes.some((index) => index.name === 'tenantId_1_userId_1')).toBe(false);

    const githubIndexes = await db().collection('githubaccounts').indexes();
    expect(githubIndexes.some((index) => index.name === 'tenantId_1_userId_1_githubUserId_1')).toBe(false);
    expect(githubIndexes.some((index) => index.name === 'uniq_github_account_tenant_workspace_user')).toBe(true);

    // 键改等价：旧字段保留、按 workspaceId 可查
    const settings = await db().collection('user_commit_settings').find({}).toArray();
    for (const row of settings) {
      expect(row.userId).toBeTruthy();
      expect(row.workspaceId).toBeTruthy();
      expect(typeof row.workspaceId).toBe('string');
    }
  });

  it('T-MIG15i: 兼容 Mongoose autoIndex 默认名索引（userId_1 / workspaceId_1）', async () => {
    await seed();
    // 模拟存量库：Mongoose 字段级 index:true 抢先用默认名建过索引
    await db().collection('user_commit_settings').dropIndex('uniq_user_commit_setting');
    await db()
      .collection('user_commit_settings')
      .createIndex({ userId: 1 }, { unique: true, name: 'userId_1' });
    await db()
      .collection('user_commit_settings')
      .createIndex({ workspaceId: 1 }, { name: 'workspaceId_1' });

    await migration.run();

    const commitIndexes = await db().collection('user_commit_settings').indexes();
    expect(commitIndexes.some((index) => index.name === 'uniq_workspace_commit_setting')).toBe(true);
    expect(commitIndexes.some((index) => index.name === 'uniq_user_commit_setting')).toBe(false);
    expect(commitIndexes.some((index) => index.name === 'userId_1')).toBe(false);
    expect(commitIndexes.some((index) => index.name === 'workspaceId_1')).toBe(false);
  });

  it('T-MIG15f: 幂等重跑零变更', async () => {
    await seed();
    await migration.run();
    const snapshot = async () => ({
      workspaces: await db().collection('workspaces').countDocuments({}),
      members: await db().collection('tenantmembers').countDocuments({}),
      providers: await db().collection('providers').countDocuments({}),
      models: await db().collection('models').countDocuments({}),
      sessions: await db().collection('sessions').countDocuments({}),
    });
    const first = await snapshot();
    await migration.run();
    expect(await snapshot()).toEqual(first);
  });

  it('T-MIG15d-guard: 复制写失败时中止且不删原件', async () => {
    await seed();
    // 制造跨租户复制冲突（同名唯一）→ 迁移必须抛错且保留原共享行
    await db().collection('providers').createIndex({ name: 1 }, { unique: true, name: 'tmp_name_unique' });
    await expect(migration.run()).rejects.toThrow();
    const legacy = await db()
      .collection('providers')
      .find({ tenantId: { $exists: false }, scope: { $ne: 'global' } })
      .toArray();
    expect(legacy.map((row) => row.name).sort()).toEqual(['no-scope', 'openai-a']);
    const legacyModels = await db()
      .collection('models')
      .find({ tenantId: { $exists: false } })
      .toArray();
    expect(legacyModels).toHaveLength(2);
  });

  it('T-MIG15g: 半完成（全局工作区缺失）重跑补齐', async () => {
    const fixture = await seed();
    await migration.run();
    // 删除一个租户的全局工作区模拟半完成
    await db()
      .collection('workspaces')
      .deleteOne({ tenantId: fixture.tenantIds[0], type: 'global' });
    await migration.run();
    expect(
      await db().collection('workspaces').countDocuments({ tenantId: fixture.tenantIds[0], type: 'global' }),
    ).toBe(1);
  });

  it('T-MIG15h: 批处理多页回填（> BATCH_SIZE）', async () => {
    const fixture = await seed();
    const tenantId = fixture.tenantIds[0];
    const userId = fixture.userIds[0];
    const docs = Array.from({ length: 520 }, () => ({
      userId,
      tenantId,
      controllerId: new mongoose.Types.ObjectId(),
      controllerName: 'c',
      acpServerType: 'opencode',
    }));
    await db().collection('sessions').insertMany(docs);
    await migration.run();
    const global = await db().collection('workspaces').findOne({ tenantId, type: 'global' });
    expect(
      await db().collection('sessions').countDocuments({ tenantId, workspaceId: global?._id }),
    ).toBe(521);
  });
});
