import mongoose from 'mongoose';

export const name = '013-tenant-id-backfill';

/** 批处理大小（每批 bulkWrite 500 条，进度日志）。 */
export const BATCH_SIZE = 500;

export interface TenantIdCollection {
  /** MongoDB 集合名（与模型实际落库集合一致，注意 mcpservers / mcpsessionendpoints 无下划线） */
  collection: string;
  /** 模型名（可读性用，等价于集合名） */
  model: string;
  /** 唯一索引扩展（F6：保留 userId 维度，只新增不删除）；缺省建 {tenantId:1} 普通索引 */
  uniqueIndex?: Record<string, 1>;
}

/**
 * 19 个带 `userId` 的集合（F10 清单）。
 *
 * 唯一索引扩展仅 3 个（F6，只新增不删除；personal 期 tenantId==userId 语义等价冗余）：
 * - `mcpservers`：`{tenantId,userId,name}`
 * - `githubaccounts`：`{tenantId,userId,githubUserId}`
 * - `user_commit_settings`：`{tenantId,userId}`
 * 其余集合仅新增 `{tenantId:1}` 普通索引。
 */
export const TENANT_ID_COLLECTIONS: readonly TenantIdCollection[] = [
  { collection: 'sessions', model: 'Session' },
  { collection: 'controllers', model: 'Controller' },
  { collection: 'controllerkeys', model: 'ControllerKey' },
  { collection: 'controllerworkspaces', model: 'ControllerWorkspace' },
  { collection: 'gateways', model: 'Gateway' },
  {
    collection: 'mcpservers',
    model: 'McpServer',
    uniqueIndex: { tenantId: 1, userId: 1, name: 1 },
  },
  { collection: 'mcpsessionendpoints', model: 'McpSessionEndpoint' },
  { collection: 'cloudhosts', model: 'CloudHost' },
  { collection: 'cloud_host_github_bindings', model: 'CloudHostGithubBinding' },
  { collection: 'cloud_host_issues_linkages', model: 'CloudHostIssuesLinkage' },
  { collection: 'cloud_host_setup_operations', model: 'CloudHostSetupOperation' },
  { collection: 'configuredworkflows', model: 'ConfiguredWorkflow' },
  { collection: 'workflowinstances', model: 'WorkflowInstance' },
  { collection: 'workflowprhandlers', model: 'WorkflowPrHandler' },
  { collection: 'workflowtemplates', model: 'WorkflowTemplate' },
  { collection: 'issueworkflowtriggers', model: 'IssueWorkflowTrigger' },
  { collection: 'todoitems', model: 'TodoItem' },
  {
    collection: 'user_commit_settings',
    model: 'UserCommitSetting',
    uniqueIndex: { tenantId: 1, userId: 1 },
  },
  {
    collection: 'githubaccounts',
    model: 'GitHubAccount',
    uniqueIndex: { tenantId: 1, userId: 1, githubUserId: 1 },
  },
];

/**
 * 迁移 013：19 个带 `userId` 的集合复制新增 `tenantId`（= userId），并建租户维度索引。
 *
 * - `userId` 字段与值全部保留（D6：本期查询为 tenantId + userId 双条件）；
 * - 只处理「userId 存在且 tenantId 缺失」的行，缺 userId 的行跳过；重跑零变更；
 * - 索引 createIndex 幂等，且**只新增不删除**既有索引（F6）。
 */
export async function run(): Promise<void> {
  for (const target of TENANT_ID_COLLECTIONS) {
    const collection = mongoose.connection.collection(target.collection);
    const backfilled = await backfillCollection(collection);
    if (target.uniqueIndex) {
      await collection.createIndex(target.uniqueIndex, { unique: true });
    } else {
      await collection.createIndex({ tenantId: 1 });
    }
    console.log(`[Migration 013] ${target.collection}: backfilled ${backfilled} rows, index ensured`);
  }
}

type Collection = ReturnType<typeof mongoose.connection.collection>;

/** 应用侧分页批处理（每批 500），返回回填行数。 */
async function backfillCollection(collection: Collection): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await collection
      .find(
        { userId: { $exists: true }, tenantId: { $exists: false } },
        { projection: { _id: 1, userId: 1 } },
      )
      .limit(BATCH_SIZE)
      .toArray();
    if (rows.length === 0) break;

    const operations = rows.map((row) => ({
      updateOne: {
        filter: { _id: row._id },
        update: { $set: { tenantId: row.userId } },
      },
    }));
    const result = await collection.bulkWrite(operations, { ordered: false });
    total += result.modifiedCount ?? rows.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}
