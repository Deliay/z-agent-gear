import type { TenantRole, WorkspaceType } from '@/graphql/types'
import { statusBadgeProps, statusLabel } from '@/lib/status-labels'

/** 租户角色文案（契约 TenantRole）；personal 租户唯一成员恒 admin。 */
export const TENANT_ROLE_LABELS: Record<TenantRole, string> = {
  admin: statusLabel('admin'),
  developer: statusLabel('developer'),
}

/** 工作区类型文案（契约 WorkspaceType）。 */
export const WORKSPACE_TYPE_LABELS: Record<WorkspaceType, string> = {
  global: statusLabel('global'),
  normal: statusLabel('normal'),
}

/** 角色下拉选项（缺省 developer，与 agent-api 内部端点口径一致）。 */
export const TENANT_ROLE_OPTIONS: TenantRole[] = ['developer', 'admin']

/** 角色缺省值（新增成员不指定角色时按开发处理）。 */
export const DEFAULT_TENANT_ROLE: TenantRole = 'developer'

/** 角色单元格文案（缺省/未知值显示「-」，不臆测角色）。 */
export function tenantRoleText(role: TenantRole | null | undefined): string {
  if (role && role in TENANT_ROLE_LABELS) return TENANT_ROLE_LABELS[role]
  return '-'
}

/** 角色徽标统一属性（管理员 primary / 开发 muted）。 */
export function tenantRoleBadge(role: TenantRole | null | undefined) {
  return statusBadgeProps(role ?? null, '-')
}

/** 租户类型徽标统一属性（个人 info / 团队 primary）。 */
export function tenantTypeBadge(type: string | null | undefined) {
  return statusBadgeProps(type, type ?? '-')
}
