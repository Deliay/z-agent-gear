import type { WorkspaceContext, WorkspaceType } from './workspace-context.js';
import type { KnowledgeBasePermissionMode } from '../models/knowledge-base.js';

/**
 * 知识库权限矩阵（**唯一判定源**，需求 #495 / 提案 D2）。
 *
 * 可见集 = 库属本工作区 ∪ 本租户全局工作区；其他普通工作区的库对本工作区成员不可见
 * （独占语义）。`visible` 是一切读写前提；非管理员在 `NONE` 模式下连可见性都没有。
 *
 * | 角色 \ 模式 | NONE | READ_ONLY | UPDATE_ONLY | FULL_ACCESS |
 * |---|---|---|---|---|
 * | admin | 全 true | 全 true | 全 true | 全 true |
 * | developer | 不可见 | 仅 canRead | + canCreate/canUpdate | + canDelete |
 *
 * 全局工作区的库对跨工作区成员**按库自身权限模式放行写**——有意偏离
 * 「全局工作区 developer 只读」的通用口径（`context.readOnly` 不参与判定，T-KBA8 锁定）。
 * `canManage`（改名/权限模式/删除库）恒 = 当前用户是租户管理员。
 */
export interface KnowledgeBaseAccessResult {
  visible: boolean;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canManage: boolean;
}

export interface KnowledgeBaseAccessInput {
  workspaceId: string;
  permissionMode: KnowledgeBasePermissionMode;
}

const NO_ACCESS: KnowledgeBaseAccessResult = {
  visible: false,
  canRead: false,
  canCreate: false,
  canUpdate: false,
  canDelete: false,
  canManage: false,
};

export function resolveKnowledgeBaseAccess(
  kb: KnowledgeBaseAccessInput,
  context: WorkspaceContext,
): KnowledgeBaseAccessResult {
  const isAdmin = context.role === 'admin';
  const inScope =
    kb.workspaceId === context.id || kb.workspaceId === context.globalWorkspaceId;
  const hidden = kb.permissionMode === 'NONE' && !isAdmin;
  const visible = inScope && !hidden;
  if (!visible) return { ...NO_ACCESS };

  const canWrite =
    isAdmin || kb.permissionMode === 'UPDATE_ONLY' || kb.permissionMode === 'FULL_ACCESS';
  return {
    visible: true,
    canRead: true,
    canCreate: canWrite,
    canUpdate: canWrite,
    canDelete: isAdmin || kb.permissionMode === 'FULL_ACCESS',
    canManage: isAdmin,
  };
}

/** 创建默认模式：全局工作区「所有人读、管理员写」→ READ_ONLY；普通工作区仅管理员 → NONE。 */
export function defaultPermissionMode(workspaceType: WorkspaceType): KnowledgeBasePermissionMode {
  return workspaceType === 'global' ? 'READ_ONLY' : 'NONE';
}
