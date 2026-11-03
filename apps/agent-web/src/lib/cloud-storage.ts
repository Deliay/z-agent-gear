import type {
  CloudStorageArchiveStatus,
  CloudStorageData,
  CloudStorageStatus,
} from '../graphql/types'

/** 云存储状态文案（对齐 contracts/cloud-storage.graphql） */
export const CLOUD_STORAGE_STATUS_LABELS: Record<CloudStorageStatus, string> = {
  CREATING: '创建中',
  IDLE: '待挂载',
  ATTACHING: '挂载中',
  ATTACHED: '已挂载',
  ARCHIVING: '归档中',
  ARCHIVED: '已归档',
  DESTROYING: '销毁中',
  DESTROYED: '已销毁',
  CREATE_FAILED: '创建失败',
}

export const CLOUD_STORAGE_ARCHIVE_STATUS_LABELS: Record<CloudStorageArchiveStatus, string> = {
  PENDING: '等待归档',
  RUNNING: '归档中',
  SUCCEEDED: '归档成功',
  FAILED: '归档失败',
}

export function cloudStorageStatusLabel(status?: CloudStorageStatus | null): string {
  return status ? (CLOUD_STORAGE_STATUS_LABELS[status] ?? status) : ''
}

export function cloudStorageArchiveStatusLabel(
  status?: CloudStorageArchiveStatus | null,
): string {
  return status ? (CLOUD_STORAGE_ARCHIVE_STATUS_LABELS[status] ?? status) : ''
}

/** 徽标颜色语义（沿用 UI Badge 的四个 variant） */
export function cloudStorageStatusBadgeVariant(
  status?: CloudStorageStatus | null,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'ATTACHED':
      return 'default'
    case 'IDLE':
    case 'CREATING':
    case 'ATTACHING':
    case 'ARCHIVING':
      return 'secondary'
    case 'CREATE_FAILED':
      return 'destructive'
    case 'ARCHIVED':
    case 'DESTROYING':
    case 'DESTROYED':
    default:
      return 'outline'
  }
}

/** 已销毁折叠区口径：DESTROYED + CREATE_FAILED（裁决 18） */
export function isDestroyedStorageStatus(status?: CloudStorageStatus | null): boolean {
  return status === 'DESTROYED' || status === 'CREATE_FAILED'
}

export function isAttachedStorage(storage?: Pick<CloudStorageData, 'status'> | null): boolean {
  return storage?.status === 'ATTACHED'
}

export function isArchivedStorage(storage?: Pick<CloudStorageData, 'status'> | null): boolean {
  return storage?.status === 'ARCHIVED'
}

/** 最近一次归档失败（ARCHIVING 且 currentArchive.status=FAILED） */
export function hasFailedArchive(
  storage?: Pick<CloudStorageData, 'status' | 'currentArchive'> | null,
): boolean {
  return storage?.status === 'ARCHIVING' && storage.currentArchive?.status === 'FAILED'
}

export function isArchiveRunning(
  storage?: Pick<CloudStorageData, 'status' | 'currentArchive'> | null,
): boolean {
  if (storage?.status !== 'ARCHIVING') return false
  return storage.currentArchive?.status !== 'FAILED'
}

/**
 * 销毁入口口径（服务端为权威）：
 * - IDLE / ARCHIVED 可销毁；
 * - ARCHIVING 且最近归档失败时允许销毁（前端额外警示）；
 * - ATTACHED / ARCHIVING（进行中）不展示入口。
 */
export function canDestroyCloudStorage(
  storage?: Pick<CloudStorageData, 'status' | 'currentArchive'> | null,
): boolean {
  if (!storage) return false
  if (storage.status === 'IDLE' || storage.status === 'ARCHIVED') return true
  return hasFailedArchive(storage)
}

/** 归档失败时销毁的额外警示文案（T-WEB6） */
export const ARCHIVE_FAILED_DESTROY_WARNING = '数据尚未成功归档，销毁后将无法恢复'

/** 字节数展示（二进制单位，保留一位小数） */
export function formatStorageBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—'
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}
