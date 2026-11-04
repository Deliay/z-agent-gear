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
  RESTORING: '复原中',
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
    case 'RESTORING':
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

/** 最近一次复原失败（RESTORING 且 currentRestore.status=FAILED） */
export function hasFailedRestore(
  storage?: Pick<CloudStorageData, 'status' | 'currentRestore'> | null,
): boolean {
  return storage?.status === 'RESTORING' && storage.currentRestore?.status === 'FAILED'
}

export function isRestoreRunning(
  storage?: Pick<CloudStorageData, 'status' | 'currentRestore'> | null,
): boolean {
  if (storage?.status !== 'RESTORING') return false
  return storage.currentRestore?.status !== 'FAILED'
}

/** 手动归档入口：仅 IDLE（工作区可写；服务端权威） */
export function canArchiveStorage(
  storage?: Pick<CloudStorageData, 'status'> | null,
): boolean {
  return storage?.status === 'IDLE'
}

/** 复原到归档入口：IDLE + SUCCEEDED 归档；RESTORING + FAILED 仅作为「重试」 */
export function canRestoreStorage(
  storage?: Pick<CloudStorageData, 'status' | 'currentArchive' | 'currentRestore'> | null,
): boolean {
  if (!storage) return false
  if (storage.status === 'IDLE') return storage.currentArchive?.status === 'SUCCEEDED'
  return hasFailedRestore(storage)
}

/** fork 入口：源有 SUCCEEDED 归档且 IDLE/ARCHIVED */
export function canForkStorage(
  storage?: Pick<CloudStorageData, 'status' | 'currentArchive'> | null,
): boolean {
  if (!storage) return false
  if (storage.status !== 'IDLE' && storage.status !== 'ARCHIVED') return false
  return storage.currentArchive?.status === 'SUCCEEDED'
}

/** 复原的破坏性二次确认文案 */
export const RESTORE_DESTRUCTIVE_WARNING =
  '当前内容将被丢弃并回滚到归档版本，不可恢复'

/**
 * 云存储契约错误文案中文映射（单一来源，列表/详情/Fork 共用；T-WEB4）。
 * 未命中的文案原样展示（服务端契约错误白名单保证不透出内部错误）。
 */
export const CLOUD_STORAGE_ERROR_MESSAGES: Record<string, string> = {
  'storage is not attached': '仅已挂载的云存储可刷新用量',
  'no archive to retry': '当前没有可重试的归档',
  'storage is not destroyable': '当前状态不可销毁云存储',
  'storage is archiving': '归档仍在进行中，暂不可操作',
  'storage is attached': '云存储仍被云电脑挂载，无法操作',
  'storage is not archivable': '仅待挂载状态可归档',
  'storage is not restorable': '当前状态不可复原到归档',
  'storage has no archive': '当前没有可用的归档',
  'storage is restoring': '复原仍在进行中，请稍后重试',
  'storage is not forkable': '源存储没有可用归档，暂不可 fork',
  'not allowed to destroy storage': '没有销毁该云存储的权限',
  'not allowed to restore storage': '没有复原该云存储的权限',
  'insufficient balance': '账户余额不足，请联系管理员充值后重试',
  'global workspace is read-only': '全局工作区为只读，无法操作云存储',
  'storage feature is disabled': '云存储功能未启用',
  'storage name is required': '请输入名称',
  'storage name is too long': '名称最多 64 个字符',
  'storage name already exists': '当前工作区已存在同名云存储',
}

export function cloudStorageErrorMessage(
  error: unknown,
  fallback = '操作失败，请稍后重试',
): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim()
    return CLOUD_STORAGE_ERROR_MESSAGES[message] ?? message
  }
  return fallback
}

/**
 * 销毁入口口径（服务端为权威）：
 * - IDLE / ARCHIVED 可销毁；
 * - ARCHIVING 且最近归档失败时允许销毁（前端额外警示）；
 * - ATTACHED / ARCHIVING（进行中）不展示入口。
 */
export function canDestroyCloudStorage(
  storage?: Pick<CloudStorageData, 'status' | 'currentArchive' | 'currentRestore'> | null,
): boolean {
  if (!storage) return false
  if (storage.status === 'IDLE' || storage.status === 'ARCHIVED') return true
  return hasFailedArchive(storage) || hasFailedRestore(storage)
}

/** 归档失败时销毁的额外警示文案（T-WEB6） */
export const ARCHIVE_FAILED_DESTROY_WARNING = '数据尚未成功归档，销毁后将无法恢复'

/** 复原失败时销毁的额外警示文案 */
export const RESTORE_FAILED_DESTROY_WARNING = '复原失败，当前数据可能不完整，销毁后将无法恢复'

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
