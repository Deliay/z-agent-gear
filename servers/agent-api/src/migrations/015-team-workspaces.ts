import mongoose from 'mongoose';

export const name = '015-team-workspaces';

export const BATCH_SIZE = 500;

/** 全局工作区固定名称（与 models/workspace.ts 一致；迁移不依赖服务层）。 */
export const GLOBAL_WORKSPACE_NAME = '全局工作区';

export interface WorkspaceIdCollection {
  collection: string;
  model: string;
  /** 租户工作区字段名（工作流域为 resourceWorkspaceId，F1） */
  field: 'workspaceId' | 'resourceWorkspaceId';
  /** 仅回填自定义行（内置模板 resourceWorkspaceId 恒 null，F9） */
  customOnly?: boolean;
}

/**
 * 9 个需要 workspace 维度回填的集合（providers/models 由复制步骤单独处理，共 11 集合）。
 * 集合名以模型 `model.collection.name` 为单一来源，由 `models/workspace-isolation.test.ts` 互校。
 */
export const WORKSPACE_ID_COLLECTIONS: readonly WorkspaceIdCollection[] = [
  { collection: 'sessions', model: 'Session', field: 'workspaceId' },
  { collection: 'controllers', model: 'Controller', field: 'workspaceId' },
  { collection: 'controllerkeys', model: 'ControllerKey', field: 'workspaceId' },
  { collection: 'cloudhosts', model: 'CloudHost', field: 'resourceWorkspaceId' },
  { collection: 'configuredworkflows', model: 'ConfiguredWorkflow', field: 'resourceWorkspaceId' },
  { collection: 'workflowinstances', model: 'WorkflowInstance', field: 'resourceWorkspaceId' },
  { collection: 'workflowtemplates', model: 'WorkflowTemplate', field: 'resourceWorkspaceId', customOnly: true },
  { collection: 'githubaccounts', model: 'GitHubAccount', field: 'workspaceId' },
  { collection: 'user_commit_settings', model: 'UserCommitSetting', field: 'workspaceId' },
];

/**
 * providers/models 复制范围：`scope:'user'` 与 `scope` 缺失的**存量共享行**（F3 v1.2）。
 * 追加 `tenantId/workspaceId 不存在` 条件区分「迁移前共享行」与「已复制行」（重跑幂等关键）。
 */
export const USER_SCOPE_COPY_FILTER = {
  $and: [
    { $or: [{ scope: 'user' }, { scope: { $exists: false } }] },
    { tenantId: { $exists: false } },
    { workspaceId: { $exists: false } },
  ],
};

type Collection = ReturnType<typeof mongoose.connection.collection>;

function stringifyId(value: unknown): string {
  return String(value);
}

/**
 * 迁移 015：多租户二期工作区化（幂等可重跑）。
 *
 * 步骤链：
 * 1. 每租户建「全局工作区」（存量 personal + 半完成补齐）；
 * 2. `tenantmembers` 回填（personal 恒 `role:'admin'`，`createdBy:'migration'`）；
 * 3. 9 集合 backfill 工作区维度 = 本租户全局工作区（providers/models 由第 5 步复制）；
 * 4. 索引切换（providers/user_commit_settings/githubaccounts，F3/F4/F8；先建新再删旧）；
 * 5. providers/models 按租户复制（含 providerId 重映射）+ 每租户计数核对 → 一致才删原共享行；
 * 6. 完成校验由调用方（测试/自检）执行。
 */
export async function run(): Promise<void> {
  const tenants = mongoose.connection.collection('tenants');
  const workspaces = mongoose.connection.collection('workspaces');
  const tenantMembers = mongoose.connection.collection('tenantmembers');
  const users = mongoose.connection.collection('users');

  // ---- 步骤 1：每租户全局工作区 ----
  const tenantRows = await tenants.find({}, { projection: { _id: 1, type: 1 } }).toArray();
  const tenantType = new Map<string, string>();
  for (const tenant of tenantRows) {
    tenantType.set(stringifyId(tenant._id), String(tenant.type ?? 'personal'));
    await workspaces.updateOne(
      { tenantId: tenant._id, type: 'global' },
      {
        $setOnInsert: {
          tenantId: tenant._id,
          name: GLOBAL_WORKSPACE_NAME,
          type: 'global',
          createdBy: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  // 兜底：半完成开户/历史 users 的 tenantId 指向不存在租户时，仍保证其有全局工作区
  const userRows = await users
    .find({}, { projection: { _id: 1, tenantId: 1 } })
    .toArray();
  for (const user of userRows) {
    const tenantId = user.tenantId ?? user._id;
    const tenantIdStr = stringifyId(tenantId);
    if (!tenantType.has(tenantIdStr)) {
      tenantType.set(tenantIdStr, 'personal');
      await tenants.updateOne(
        { _id: tenantId },
        { $setOnInsert: { _id: tenantId, name: tenantIdStr, type: 'personal', createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true },
      );
      await workspaces.updateOne(
        { tenantId, type: 'global' },
        {
          $setOnInsert: {
            tenantId,
            name: GLOBAL_WORKSPACE_NAME,
            type: 'global',
            createdBy: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }

  const globalWorkspaces = await workspaces
    .find({ type: 'global' }, { projection: { _id: 1, tenantId: 1 } })
    .toArray();
  const globalByTenant = new Map<string, string>();
  for (const workspace of globalWorkspaces) {
    globalByTenant.set(stringifyId(workspace.tenantId), stringifyId(workspace._id));
  }
  console.log(`[Migration 015] global workspaces: ${globalByTenant.size}`);

  // ---- 步骤 2：tenantmembers 回填 ----
  const adminSeeded = new Set<string>();
  for (const user of userRows) {
    const tenantId = user.tenantId ?? user._id;
    const tenantIdStr = stringifyId(tenantId);
    const isPersonal = (tenantType.get(tenantIdStr) ?? 'personal') === 'personal';
    const role = isPersonal || !adminSeeded.has(tenantIdStr) ? 'admin' : 'developer';
    if (role === 'admin') adminSeeded.add(tenantIdStr);
    await tenantMembers.updateOne(
      { tenantId, userId: user._id },
      {
        $setOnInsert: {
          tenantId,
          userId: user._id,
          role,
          createdBy: 'migration',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  // 半完成：tenantmembers 缺 role 的历史行补齐（按租户类型 personal=admin，team 需保留至少一名 admin）
  await tenantMembers.updateMany(
    { role: { $exists: false } },
    [{ $set: { role: 'developer', updatedAt: new Date() } }],
  );
  for (const [tenantIdStr, type] of tenantType) {
    if (type !== 'personal') continue;
    await tenantMembers.updateMany(
      { tenantId: new mongoose.Types.ObjectId(tenantIdStr), role: { $ne: 'admin' } },
      { $set: { role: 'admin', updatedAt: new Date() } },
    );
  }
  console.log('[Migration 015] tenantmembers backfilled');

  // ---- 步骤 3：9 集合工作区维度 backfill ----
  for (const target of WORKSPACE_ID_COLLECTIONS) {
    const collection = mongoose.connection.collection(target.collection);
    const backfilled = await backfillWorkspaceField(collection, target, globalByTenant);
    // 索引：租户+工作区复合索引（幂等）
    await collection.createIndex({ tenantId: 1, [target.field]: 1 });
    console.log(`[Migration 015] ${target.collection}: backfilled ${backfilled} rows`);
  }

  // ---- 步骤 4：索引切换（先建新 → 再删旧）----
  await switchIndexes();

  // ---- 步骤 5：providers/models 按租户复制 ----
  await copyProvidersAndModels(globalByTenant);

  console.log('[Migration 015] completed');
}

async function backfillWorkspaceField(
  collection: Collection,
  target: WorkspaceIdCollection,
  globalByTenant: Map<string, string>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const filter: Record<string, unknown> = {
      [target.field]: { $in: [null, undefined] },
    };
    if (target.customOnly) {
      filter.userId = { $exists: true, $ne: null };
    }
    const rows = await collection
      .find(filter, { projection: { _id: 1, tenantId: 1, userId: 1 } })
      .limit(BATCH_SIZE)
      .toArray();
    if (rows.length === 0) break;

    const operations = [];
    for (const row of rows) {
      const tenantId = row.tenantId ?? row.userId;
      const workspaceId = globalByTenant.get(stringifyId(tenantId));
      if (!workspaceId) continue;
      operations.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { [target.field]: new mongoose.Types.ObjectId(workspaceId) } },
        },
      });
    }
    if (operations.length === 0) break;
    const result = await collection.bulkWrite(operations, { ordered: false });
    total += result.modifiedCount ?? operations.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}

async function switchIndexes(): Promise<void> {
  const providers = mongoose.connection.collection('providers');
  await providers.createIndex(
    { tenantId: 1, workspaceId: 1, name: 1 },
    { unique: true, name: 'uniq_provider_tenant_workspace_name', partialFilterExpression: { scope: 'user' } },
  );
  await providers.createIndex(
    { name: 1 },
    { unique: true, name: 'uniq_provider_global_name', partialFilterExpression: { scope: 'global' } },
  );
  await dropIndexSafe(providers, 'scope_1_name_1');

  const models = mongoose.connection.collection('models');
  await models.createIndex({ tenantId: 1, workspaceId: 1 }, { name: 'tenantId_1_workspaceId_1' });

  const commitSettings = mongoose.connection.collection('user_commit_settings');
  await commitSettings.createIndex(
    { workspaceId: 1 },
    { unique: true, name: 'uniq_workspace_commit_setting' },
  );
  await dropIndexSafe(commitSettings, 'uniq_user_commit_setting');
  await dropIndexSafe(commitSettings, 'userId_1');
  await dropIndexSafe(commitSettings, 'tenantId_1_userId_1');

  const githubAccounts = mongoose.connection.collection('githubaccounts');
  await githubAccounts.createIndex(
    { tenantId: 1, workspaceId: 1, githubUserId: 1 },
    { unique: true, name: 'uniq_github_account_tenant_workspace_user' },
  );
  await dropIndexSafe(githubAccounts, 'tenantId_1_userId_1_githubUserId_1');

  console.log('[Migration 015] indexes switched');
}

async function dropIndexSafe(collection: Collection, indexName: string): Promise<void> {
  try {
    await collection.dropIndex(indexName);
    console.log(`[Migration 015] dropped index ${indexName}`);
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (!/index not found|ns not found/i.test(message)) {
      throw err;
    }
  }
}

/**
 * providers/models 存量 user 域行按租户复制到各租户全局工作区（含 providerId 重映射）。
 *
 * 幂等：以 `{tenantId,workspaceId,name,scope:'user'}` / `{providerId,name}` upsert；
 * 删除门禁：每租户复制数（按源名称集合计数）== 原共享行数，全部一致才删除原件；
 * 任一租户不一致 → 中止且**不删原件**（迁移失败可重跑）。
 */
async function copyProvidersAndModels(globalByTenant: Map<string, string>): Promise<void> {
  const providers = mongoose.connection.collection('providers');
  const models = mongoose.connection.collection('models');

  const sourceProviders = await providers.find(USER_SCOPE_COPY_FILTER).toArray();
  const sourceModels = sourceProviders.length
    ? await models.find({ providerId: { $in: sourceProviders.map((p) => p._id) } }).toArray()
    : [];

  if (sourceProviders.length === 0 && sourceModels.length === 0) {
    console.log('[Migration 015] providers/models: no shared rows to copy');
    return;
  }

  const expectedProviders = sourceProviders.length;
  const expectedModels = sourceModels.length;
  console.log(
    `[Migration 015] providers/models copy: providers=${expectedProviders} models=${expectedModels} tenantWorkspaces=${globalByTenant.size}`,
  );

  const legacyProviderIds = new Set(sourceProviders.map((p) => stringifyId(p._id)));
  // providerId → 新 provider（按租户）
  const remap = new Map<string, string>();

  for (const [tenantIdStr, workspaceIdStr] of globalByTenant) {
    const tenantId = new mongoose.Types.ObjectId(tenantIdStr);
    const workspaceId = new mongoose.Types.ObjectId(workspaceIdStr);

    for (const provider of sourceProviders) {
      const { _id, createdAt, updatedAt, ...rest } = provider as Record<string, unknown>;
      await providers.updateOne(
        { tenantId, workspaceId, name: rest.name as string, scope: 'user' },
        {
          $set: { ...rest, scope: 'user', tenantId, workspaceId },
          $setOnInsert: { createdAt: createdAt ?? new Date(), updatedAt: updatedAt ?? new Date() },
        },
        { upsert: true },
      );
      const created = await providers.findOne(
        { tenantId, workspaceId, name: rest.name as string, scope: 'user' },
        { projection: { _id: 1 } },
      );
      if (!created) throw new Error(`[Migration 015] provider copy failed: ${String(rest.name)}`);
      remap.set(`${tenantIdStr}:${stringifyId(_id)}`, stringifyId(created._id));
    }

    for (const model of sourceModels) {
      const providerId = stringifyId(model.providerId);
      if (!legacyProviderIds.has(providerId)) continue;
      const newProviderId = remap.get(`${tenantIdStr}:${providerId}`);
      if (!newProviderId) {
        throw new Error(`[Migration 015] provider remap missing for model ${stringifyId(model._id)}`);
      }
      const { _id, createdAt, updatedAt, ...rest } = model as Record<string, unknown>;
      await models.updateOne(
        { providerId: new mongoose.Types.ObjectId(newProviderId), name: rest.name as string },
        {
          $set: {
            ...rest,
            providerId: new mongoose.Types.ObjectId(newProviderId),
            scope: 'user',
            tenantId,
            workspaceId,
          },
          $setOnInsert: { createdAt: createdAt ?? new Date(), updatedAt: updatedAt ?? new Date() },
        },
        { upsert: true },
      );
    }

    // 计数门禁：按源名称集合核对（幂等重跑不会因重复 upsert 改变计数）
    const providerNames = sourceProviders.map((p) => (p as Record<string, unknown>).name as string);
    const copiedProviderCount = await providers.countDocuments({
      tenantId,
      workspaceId,
      scope: 'user',
      name: { $in: providerNames },
    });
    const copiedModelProviderIds = [...remap.entries()]
      .filter(([key]) => key.startsWith(`${tenantIdStr}:`))
      .map(([, value]) => new mongoose.Types.ObjectId(value));
    const copiedModelCount = await models.countDocuments({
      providerId: { $in: copiedModelProviderIds },
      tenantId,
      workspaceId,
    });

    if (copiedProviderCount !== expectedProviders || copiedModelCount !== expectedModels) {
      throw new Error(
        `[Migration 015] copy count mismatch for tenant ${tenantIdStr}: providers ${copiedProviderCount}/${expectedProviders}, models ${copiedModelCount}/${expectedModels}; originals kept`,
      );
    }
  }

  // 全部租户核对一致 → 删除原共享行（唯一删除步骤，快照兜底）
  const originalProviderIds = sourceProviders.map((p) => p._id);
  const originalModelIds = sourceModels.map((m) => m._id);
  if (originalModelIds.length > 0) {
    await models.deleteMany({ _id: { $in: originalModelIds } });
  }
  if (originalProviderIds.length > 0) {
    await providers.deleteMany({ _id: { $in: originalProviderIds } });
  }
  console.log(
    `[Migration 015] deleted shared rows: providers=${originalProviderIds.length} models=${originalModelIds.length}`,
  );
}
