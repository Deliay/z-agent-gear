import mongoose from 'mongoose';

/**
 * 直插夹具用：解析用户个人租户的全局工作区 id。
 *
 * 多租户二期起，`controllers` / `sessions` / `cloudhosts`（`resourceWorkspaceId`）等集合
 * 由 `applyWorkspaceScope` 按请求工作区上下文注入可见性过滤；缺省上下文回退到个人租户
 * 全局工作区。直接写库构造的夹具必须显式带上该 id，否则接口查询会因作用域过滤不可见。
 */
export async function personalGlobalWorkspaceId(
  db: mongoose.mongo.Db,
  userId: string,
): Promise<mongoose.Types.ObjectId> {
  const tenantId = new mongoose.Types.ObjectId(userId);
  const workspace = await db.collection('workspaces').findOne({ tenantId, type: 'global' });
  if (!workspace) {
    throw new Error(`personal global workspace not found for user ${userId}`);
  }
  return workspace._id as mongoose.Types.ObjectId;
}
