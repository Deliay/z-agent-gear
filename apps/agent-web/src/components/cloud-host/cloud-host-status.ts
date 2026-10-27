import type { CloudHostData, CloudHostStatus } from '../../graphql/types'

/** 云电脑状态文案（对齐实现计划 Phase 8 状态映射） */
export const CLOUD_HOST_STATUS_LABELS: Record<CloudHostStatus, string> = {
  STARTING: '启动中',
  RUNNING: '运行中',
  STOPPING: '停止中',
  STOPPED: '已销毁',
  FAILED: '失败',
}

export const CLOUD_HOST_ACTIVE_STATUSES: CloudHostStatus[] = ['STARTING', 'RUNNING', 'STOPPING']

export const CLOUD_HOST_DELETABLE_STATUSES: CloudHostStatus[] = ['STOPPED', 'FAILED']

export function cloudHostStatusLabel(status?: CloudHostStatus | null): string {
  return status ? (CLOUD_HOST_STATUS_LABELS[status] ?? status) : ''
}

/** 活跃状态（STARTING/RUNNING/STOPPING）；仅用于状态展示/只读判定，不再限制数量 */
export function isActiveCloudHost(cloudHost?: CloudHostData | null): boolean {
  return Boolean(cloudHost && !cloudHost.deletedAt && CLOUD_HOST_ACTIVE_STATUSES.includes(cloudHost.status))
}

/** 终态：已销毁 / 失败 / 已软删除 */
export function isTerminalCloudHost(cloudHost?: CloudHostData | null): boolean {
  if (!cloudHost) return false
  return Boolean(cloudHost.deletedAt) || cloudHost.status === 'STOPPED' || cloudHost.status === 'FAILED'
}

/** 云电脑终态时会话只读回看（无输入/继续/恢复） */
export function isReadOnlyCloudHost(cloudHost?: CloudHostData | null): boolean {
  return isTerminalCloudHost(cloudHost)
}

export function canDeleteCloudHost(cloudHost?: Pick<CloudHostData, 'status' | 'deletedAt'> | null): boolean {
  return Boolean(cloudHost && !cloudHost.deletedAt && CLOUD_HOST_DELETABLE_STATUSES.includes(cloudHost.status))
}

export function canStopCloudHost(cloudHost?: Pick<CloudHostData, 'status' | 'deletedAt'> | null): boolean {
  return Boolean(cloudHost && !cloudHost.deletedAt && (cloudHost.status === 'STARTING' || cloudHost.status === 'RUNNING'))
}

export function cloudHostStatusDotClass(status?: CloudHostStatus | null): string {
  switch (status) {
    case 'STARTING':
    case 'STOPPING':
      return 'bg-warning animate-pulse'
    case 'RUNNING':
      return 'bg-success'
    case 'FAILED':
      return 'bg-destructive'
    case 'STOPPED':
    default:
      return 'bg-muted-foreground'
  }
}
