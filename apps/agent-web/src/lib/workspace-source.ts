import type { WorkspaceData } from '../graphql/types';

export type ResourceSourceKind = 'workspace' | 'global' | 'other' | 'unknown';

export interface ResourceSource {
  kind: ResourceSourceKind;
  /** 徽标文案；unknown（旧数据未携带字段）不展示 */
  label: string | null;
  /** 是否允许在当前上下文编辑/删除该资源 */
  editable: boolean;
}

/**
 * 共享资源来源判定（供应商/模型/GitHub 绑定等，多租户二期）：
 * - 当前工作区自身行：可编辑（全局工作区 + developer 由上下文只读统一收敛）。
 * - 本租户全局工作区行（且当前不在该上下文）：普通上下文只读。
 * - 平台内置/其他工作区行：只读。
 * - 旧数据未携带 workspaceId（undefined）：按来源未知处理，保持升级前行为。
 */
export function resolveResourceSource(
  workspaceId: string | null | undefined,
  current: WorkspaceData | null,
  workspaces: WorkspaceData[],
): ResourceSource {
  if (workspaceId === undefined) {
    return { kind: 'unknown', label: null, editable: true };
  }
  const contextReadOnly = current?.readOnly === true;
  if (workspaceId === null) {
    return { kind: 'global', label: '全局工作区', editable: false };
  }
  if (current && workspaceId === current.id) {
    return { kind: 'workspace', label: '本工作区', editable: !contextReadOnly };
  }
  const sourceWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  if (sourceWorkspace?.type === 'global') {
    return { kind: 'global', label: '全局工作区', editable: false };
  }
  return { kind: 'other', label: '其他工作区', editable: false };
}
