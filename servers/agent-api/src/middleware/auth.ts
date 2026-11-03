import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { User } from '../models/user.js';
import { Workspace } from '../models/workspace.js';
import { TenantMember } from '../models/tenant-member.js';
import { WorkspaceMember } from '../models/workspace-member.js';
import { verifyToken } from '../services/auth.js';
import type { TenantRole, WorkspaceContext } from '../services/workspace-context.js';

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  name: string;
}

const WORKSPACE_NOT_FOUND = 'workspace not found';

/**
 * JWT 校验后直读用户：一次 findById 同时取得身份与租户归属（tenantId），零额外查询。
 * 一期 personal 租户 `_id` 复用 userId，历史/半迁移行缺失 tenantId 时回退为 userId。
 */
export async function authenticateUser(request: Request): Promise<AuthenticatedUser | null> {
  const header = request.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice(7);
  if (!token) {
    return null;
  }

  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.userId).select('tenantId name');
    if (!user) {
      return null;
    }
    const id = user._id.toString();
    return {
      id,
      tenantId: user.tenantId ? user.tenantId.toString() : id,
      name: user.name ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * 按工作区 id 解析请求上下文（多租户二期，裁决 1）：
 * - Workspace.findById → 取 tenantmembers.role → 可访问性校验
 *   （admin 直通全部工作区；global 需租户成员；normal 需 workspacemembers 成员）；
 * - `readOnly = type==='global' && role==='developer'`；
 * - 非法/不可达 id 一律 `workspace not found`（不泄露存在性）。
 *
 * 供 GraphQL 的 `x-workspace-id` 与 SSE（EventSource 不能设请求头）共用，保证两侧口径一致。
 */
export async function resolveWorkspaceContext(
  user: AuthenticatedUser,
  workspaceId: string,
): Promise<WorkspaceContext> {
  if (!mongoose.isValidObjectId(workspaceId)) throw new GraphQLError(WORKSPACE_NOT_FOUND);
  const workspace = await Workspace.findById(workspaceId).lean();
  if (!workspace) throw new GraphQLError(WORKSPACE_NOT_FOUND);
  const tenantId = String(workspace.tenantId);
  const membership = await TenantMember.findOne({ tenantId, userId: user.id }).lean();
  if (!membership) throw new GraphQLError(WORKSPACE_NOT_FOUND);
  const role = (membership.role as TenantRole) ?? 'developer';
  const type = workspace.type === 'global' ? 'global' : 'normal';
  if (role !== 'admin' && type === 'normal') {
    const join = await WorkspaceMember.findOne({ workspaceId: workspace._id, userId: user.id }).lean();
    if (!join) throw new GraphQLError(WORKSPACE_NOT_FOUND);
  }
  const globalWorkspace = await Workspace.findOne({ tenantId, type: 'global' })
    .select('_id')
    .lean();
  return {
    id: String(workspace._id),
    tenantId,
    type,
    role,
    readOnly: type === 'global' && role === 'developer',
    globalWorkspaceId: globalWorkspace
      ? String(globalWorkspace._id)
      : type === 'global'
        ? String(workspace._id)
        : '',
  };
}

/**
 * 解析 `x-workspace-id`（多租户二期，裁决 1）；缺省/缺头回退「个人租户全局工作区」
 * （role=admin、readOnly=false），与一期完全等价。
 */
export async function resolveWorkspaceAccess(
  request: Request,
  user: AuthenticatedUser,
): Promise<WorkspaceContext | undefined> {
  const raw = request.headers.get('x-workspace-id');
  const headerId = typeof raw === 'string' ? raw.trim() : '';

  if (headerId) {
    return resolveWorkspaceContext(user, headerId);
  }

  // 缺省回退：个人租户（users.tenantId）全局工作区；缺数据（半迁移）时返回 undefined 保持一期行为。
  const global = await Workspace.findOne({ tenantId: user.tenantId, type: 'global' })
    .select('_id tenantId')
    .lean();
  if (!global) return undefined;
  return {
    id: String(global._id),
    tenantId: String(global.tenantId),
    type: 'global',
    role: 'admin',
    readOnly: false,
    globalWorkspaceId: String(global._id),
  };
}
