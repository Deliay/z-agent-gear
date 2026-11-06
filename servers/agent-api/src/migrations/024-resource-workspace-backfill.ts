import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';

export const name = '024-resource-workspace-backfill';

export const BATCH_SIZE = 500;

const log = logger.child({ component: 'migration/024-resource-workspace-backfill' });

type Collection = ReturnType<typeof mongoose.connection.collection>;

interface WorkspaceOwnership {
  workspaceId: string;
  tenantId: string | null;
}

/**
 * 迁移 024：补齐租户工作区维度缺失的存量资源（幂等可重跑）。
 *
 * 背景：早期/后台链路（无请求 ALS 上下文）创建的会话、云电脑与已配置工作流可能
 * 没有写入 `workspaceId` / `resourceWorkspaceId`。工作区可见性过滤以该字段为准，
 * 结果就是「A 创建、同工作区 B 看不到」。
 *
 * 归属推导（与运行期一致）：资源 → 控制器 → 控制器所属租户工作区；工作流实例
 * 优先取已配置工作流的工作区，否则回退控制器。只处理字段为 null 的行；无法推导
 * 归属（控制器已删除等）的行保持原样，不猜测。
 */
export async function run(): Promise<void> {
  const controllerOwnership = await loadControllerOwnership();
  const result: Record<string, number> = {};

  result.cloudhosts = await backfillByController(
    mongoose.connection.collection('cloudhosts'),
    'resourceWorkspaceId',
    controllerOwnership,
  );
  result.configuredworkflows = await backfillByController(
    mongoose.connection.collection('configuredworkflows'),
    'resourceWorkspaceId',
    controllerOwnership,
  );
  result.workflowinstances = await backfillByController(
    mongoose.connection.collection('workflowinstances'),
    'resourceWorkspaceId',
    controllerOwnership,
  );
  // 实例的 configuredWorkflowId 指向的配置可能比实例更早补齐；作为控制器推导的第二来源。
  result.workflowinstances += await backfillInstancesByConfiguredWorkflow();
  result.sessions = await backfillByController(
    mongoose.connection.collection('sessions'),
    'workspaceId',
    controllerOwnership,
  );

  log.info({ ...result, controllers: controllerOwnership.size }, 'resource workspace backfill completed');
}

async function loadControllerOwnership(): Promise<Map<string, WorkspaceOwnership>> {
  const rows = await mongoose.connection
    .collection('controllers')
    .find(
      { workspaceId: { $ne: null } },
      { projection: { _id: 1, workspaceId: 1, tenantId: 1 } },
    )
    .toArray();
  const map = new Map<string, WorkspaceOwnership>();
  for (const row of rows) {
    if (!row.workspaceId) continue;
    map.set(String(row._id), {
      workspaceId: String(row.workspaceId),
      tenantId: row.tenantId ? String(row.tenantId) : null,
    });
  }
  return map;
}

async function backfillByController(
  collection: Collection,
  field: string,
  ownership: Map<string, WorkspaceOwnership>,
): Promise<number> {
  let updated = 0;
  for (;;) {
    const rows = await collection
      .find(
        { [field]: null, controllerId: { $ne: null } },
        { projection: { _id: 1, controllerId: 1 } },
      )
      .limit(BATCH_SIZE)
      .toArray();
    if (rows.length === 0) break;

    const operations = [];
    for (const row of rows) {
      const target = ownership.get(String(row.controllerId));
      if (!target) continue;
      operations.push({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              [field]: new mongoose.Types.ObjectId(target.workspaceId),
              ...(target.tenantId
                ? { tenantId: new mongoose.Types.ObjectId(target.tenantId) }
                : {}),
            },
          },
        },
      });
    }
    // 本批全部无法推导（控制器缺失）→ 停止，避免反复扫描同一批。
    if (operations.length === 0) break;

    const batch = await collection.bulkWrite(operations, { ordered: false });
    updated += batch.modifiedCount ?? operations.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return updated;
}

async function backfillInstancesByConfiguredWorkflow(): Promise<number> {
  const configured = await mongoose.connection
    .collection('configuredworkflows')
    .find(
      { resourceWorkspaceId: { $ne: null } },
      { projection: { _id: 1, resourceWorkspaceId: 1, tenantId: 1 } },
    )
    .toArray();
  if (configured.length === 0) return 0;

  const ownership = new Map<string, WorkspaceOwnership>();
  for (const row of configured) {
    if (!row.resourceWorkspaceId) continue;
    ownership.set(String(row._id), {
      workspaceId: String(row.resourceWorkspaceId),
      tenantId: row.tenantId ? String(row.tenantId) : null,
    });
  }

  let updated = 0;
  for (;;) {
    const rows = await mongoose.connection
      .collection('workflowinstances')
      .find(
        { resourceWorkspaceId: null, configuredWorkflowId: { $ne: null } },
        { projection: { _id: 1, configuredWorkflowId: 1 } },
      )
      .limit(BATCH_SIZE)
      .toArray();
    if (rows.length === 0) break;

    const operations = [];
    for (const row of rows) {
      const target = ownership.get(String(row.configuredWorkflowId));
      if (!target) continue;
      operations.push({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              resourceWorkspaceId: new mongoose.Types.ObjectId(target.workspaceId),
              ...(target.tenantId
                ? { tenantId: new mongoose.Types.ObjectId(target.tenantId) }
                : {}),
            },
          },
        },
      });
    }
    if (operations.length === 0) break;

    const batch = await mongoose.connection
      .collection('workflowinstances')
      .bulkWrite(operations, { ordered: false });
    updated += batch.modifiedCount ?? operations.length;
    if (rows.length < BATCH_SIZE) break;
  }
  return updated;
}
