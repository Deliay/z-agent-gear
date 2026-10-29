import mongoose from 'mongoose';

/** 租户工作区集合（agent-api 写方；本服务只读，仅用于解析全局工作区回退）。 */
export const WORKSPACES_COLLECTION = 'workspaces';

/**
 * 构造 `workspaces.tenantId` 的兼容查询候选（多租户二期 / 附录 A workspaceId 口径）。
 *
 * `workspaces` 由 agent-api 管理，其 `tenantId` 为 **ObjectId**（`models/workspace.ts`）；
 * 而 `cloudcontainers.tenantId` 为 **String**（一期 F8）。为避免一侧口径变化导致解析失败，
 * 同时匹配字符串与 ObjectId 两种存储形态（合法 24 位 hex 才有 ObjectId 候选）。
 */
export function buildTenantIdCandidates(tenantId: string): unknown[] {
  const candidates: unknown[] = [tenantId];
  if (mongoose.isValidObjectId(tenantId)) {
    candidates.push(new mongoose.Types.ObjectId(tenantId));
  }
  return candidates;
}

/**
 * 按租户解析**全局工作区** ID（`{tenantId, type:'global'}`，每租户恰一个）。
 *
 * - 返回 `String(workspaces._id)`（写入 `cloudcontainers.workspaceId` 的 String 口径）；
 * - 解析不到（无该租户 / 未建全局工作区）返回 `null`，由调用方按口径记录 warn 或置 null；
 * - **未连接数据库时不查询**：单测/初始化阶段直接返回 null，避免 Mongoose 命令缓冲导致请求挂起
 *   （生产链路由 `index.ts` 在 `mongoose.connect` 之后才 listen，不受影响）。
 */
export async function resolveGlobalWorkspaceId(
  tenantId: string | null | undefined,
): Promise<string | null> {
  const normalized = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!normalized) return null;
  if (mongoose.connection.readyState !== 1) return null;

  const doc = await mongoose.connection
    .collection(WORKSPACES_COLLECTION)
    .findOne(
      { tenantId: { $in: buildTenantIdCandidates(normalized) }, type: 'global' },
      { projection: { _id: 1 } },
    );
  return doc ? String(doc._id) : null;
}
