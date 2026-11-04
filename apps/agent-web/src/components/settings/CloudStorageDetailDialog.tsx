import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { CLOUD_STORAGE } from '@/graphql/queries'
import {
  ARCHIVE_CLOUD_STORAGE,
  DESTROY_CLOUD_STORAGE,
  REFRESH_CLOUD_STORAGE_USAGE,
  RESTORE_CLOUD_STORAGE_TO_ARCHIVE,
  RETRY_CLOUD_STORAGE_ARCHIVE,
} from '@/graphql/mutations'
import type {
  ArchiveCloudStorageMutation,
  CloudStorageData,
  DestroyCloudStorageMutation,
  GetCloudStorageQuery,
  RefreshCloudStorageUsageMutation,
  RestoreCloudStorageToArchiveMutation,
  RetryCloudStorageArchiveMutation,
} from '@/graphql/types'
import {
  ARCHIVE_FAILED_DESTROY_WARNING,
  RESTORE_DESTRUCTIVE_WARNING,
  RESTORE_FAILED_DESTROY_WARNING,
  canArchiveStorage,
  canDestroyCloudStorage,
  canForkStorage,
  canRestoreStorage,
  cloudStorageArchiveStatusLabel,
  cloudStorageErrorMessage,
  cloudStorageStatusBadgeVariant,
  cloudStorageStatusLabel,
  formatStorageBytes,
  hasFailedArchive,
  hasFailedRestore,
  isAttachedStorage,
} from '@/lib/cloud-storage'
import { formatDateTime } from '@/lib/format'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import ForkCloudStorageDialog from './ForkCloudStorageDialog'

interface CloudStorageDetailDialogProps {
  open: boolean
  storageId: string | null
  onClose: () => void
  /** 刷新/重试/销毁后通知列表刷新 */
  onChanged?: () => void
  /** 销毁成功回调（列表侧可据此关闭详情） */
  onDestroyed?: () => void
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}：</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  )
}

/**
 * 云存储详情：基本信息 / 实际占用（仅 ATTACHED 可刷新）/ 当前归档（可重试失败归档）/ 销毁。
 * 状态与权限规则由服务端权威拦截，前端只做入口收敛与二次确认。
 */
export default function CloudStorageDetailDialog({
  open,
  storageId,
  onClose,
  onChanged,
  onDestroyed,
}: CloudStorageDetailDialogProps) {
  const { data, loading, error: queryError, refetch } = useQuery<GetCloudStorageQuery>(
    CLOUD_STORAGE,
    {
      variables: { id: storageId ?? '' },
      skip: !open || !storageId,
      fetchPolicy: 'cache-and-network',
    },
  )
  const [refreshUsage] = useMutation<RefreshCloudStorageUsageMutation>(
    REFRESH_CLOUD_STORAGE_USAGE,
  )
  const [retryArchive] = useMutation<RetryCloudStorageArchiveMutation>(
    RETRY_CLOUD_STORAGE_ARCHIVE,
  )
  const [destroyStorage] = useMutation<DestroyCloudStorageMutation>(DESTROY_CLOUD_STORAGE)
  const [archiveStorage] = useMutation<ArchiveCloudStorageMutation>(ARCHIVE_CLOUD_STORAGE)
  const [restoreStorage] = useMutation<RestoreCloudStorageToArchiveMutation>(
    RESTORE_CLOUD_STORAGE_TO_ARCHIVE,
  )

  const [refreshing, setRefreshing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [destroying, setDestroying] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [forkOpen, setForkOpen] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRefreshing(false)
    setRetrying(false)
    setDestroyOpen(false)
    setDestroying(false)
    setArchiveOpen(false)
    setRestoreOpen(false)
    setForkOpen(false)
    setActionBusy(false)
    setActionError(null)
  }, [open, storageId])

  const storage: CloudStorageData | null | undefined = data?.cloudStorage
  const attached = isAttachedStorage(storage)
  const archiveFailed = hasFailedArchive(storage)
  const restoreFailed = hasFailedRestore(storage)
  const destroyable = canDestroyCloudStorage(storage)
  const archivable = canArchiveStorage(storage)
  const restorable = canRestoreStorage(storage)
  const forkable = canForkStorage(storage)
  const archive = storage?.currentArchive ?? null
  const restore = storage?.currentRestore ?? null

  const handleRefreshUsage = async () => {
    if (!storage || !attached || refreshing) return
    setRefreshing(true)
    setActionError(null)
    try {
      await refreshUsage({ variables: { id: storage.id } })
      await refetch()
      toast.success('已发起用量刷新')
      onChanged?.()
    } catch (err) {
      setActionError(cloudStorageErrorMessage(err))
    } finally {
      setRefreshing(false)
    }
  }

  const handleRetryArchive = async () => {
    if (!storage || retrying) return
    setRetrying(true)
    setActionError(null)
    try {
      await retryArchive({ variables: { id: storage.id } })
      await refetch()
      toast.success('已重新发起归档')
      onChanged?.()
    } catch (err) {
      setActionError(cloudStorageErrorMessage(err))
    } finally {
      setRetrying(false)
    }
  }

  const handleArchive = async () => {
    if (!storage || actionBusy) return
    setActionBusy(true)
    setActionError(null)
    try {
      await archiveStorage({ variables: { id: storage.id } })
      setArchiveOpen(false)
      await refetch()
      toast.success('已发起归档，完成后将按半价计费')
      onChanged?.()
    } catch (err) {
      setActionError(cloudStorageErrorMessage(err))
    } finally {
      setActionBusy(false)
    }
  }

  const handleRestore = async () => {
    if (!storage || actionBusy) return
    setActionBusy(true)
    setActionError(null)
    try {
      await restoreStorage({ variables: { id: storage.id } })
      setRestoreOpen(false)
      await refetch()
      toast.success('已发起复原，完成后回到待挂载')
      onChanged?.()
    } catch (err) {
      setActionError(cloudStorageErrorMessage(err))
    } finally {
      setActionBusy(false)
    }
  }

  const handleDestroy = async () => {
    if (!storage || destroying) return
    setDestroying(true)
    setActionError(null)
    try {
      await destroyStorage({ variables: { id: storage.id } })
      setDestroyOpen(false)
      toast.success('云存储已销毁')
      onChanged?.()
      onDestroyed?.()
      onClose()
    } catch (err) {
      setActionError(cloudStorageErrorMessage(err))
    } finally {
      setDestroying(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
        <DialogContent className="min-w-0 max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>云存储详情</DialogTitle>
            <DialogDescription>
              {storage?.name ?? '云存储'}
            </DialogDescription>
          </DialogHeader>

          {loading && !data ? (
            <p className="text-sm text-muted-foreground">加载中...</p>
          ) : queryError && !storage ? (
            <div className="space-y-2">
              <p role="alert" className="break-words text-sm text-destructive">
                {cloudStorageErrorMessage(queryError)}
              </p>
              <Button type="button" variant="outline" onClick={() => { void refetch() }}>
                重试
              </Button>
            </div>
          ) : storage ? (
            <div className="min-w-0 space-y-4">
              <section className="space-y-2" data-testid="cloud-storage-basic-info">
                <h3 className="text-sm font-medium">基本信息</h3>
                <DetailRow label="名称">{storage.name}</DetailRow>
                <DetailRow label="容量">{storage.sizeGi}Gi</DetailRow>
                <DetailRow label="每小时费用">
                  {storage.hourlyCreditsFull} credits（归档后 {storage.hourlyCreditsArchived} credits）
                </DetailRow>
                <DetailRow label="归档空间">
                  {storage.archiveSpace.usedGi === null
                    ? `由平台管理（上限 ${storage.archiveSpace.capacityGi}Gi）`
                    : `${storage.archiveSpace.usedGi}Gi / ${storage.archiveSpace.capacityGi}Gi`}
                </DetailRow>
                <DetailRow label="状态">
                  <Badge variant={cloudStorageStatusBadgeVariant(storage.status)}>
                    {cloudStorageStatusLabel(storage.status)}
                  </Badge>
                </DetailRow>
                <DetailRow label="创建人">{storage.createdBy.name}</DetailRow>
                <DetailRow label="创建时间">{formatDateTime(storage.createdAt)}</DetailRow>
                <DetailRow label="挂载的云电脑">
                  {storage.attachedCloudHostName ?? '无'}
                </DetailRow>
                {storage.failureReason && (
                  <DetailRow label="失败原因">
                    <span className="text-destructive">{storage.failureReason}</span>
                  </DetailRow>
                )}
              </section>

              <section className="space-y-2 border-t pt-3" data-testid="cloud-storage-usage">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">实际占用</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!attached || refreshing}
                    onClick={() => { void handleRefreshUsage() }}
                  >
                    {refreshing ? '刷新中...' : '刷新用量'}
                  </Button>
                </div>
                <DetailRow label="占用大小">{formatStorageBytes(storage.usageBytes)}</DetailRow>
                <DetailRow label="更新时间">{formatDateTime(storage.usageUpdatedAt)}</DetailRow>
                {!attached && (
                  <p className="text-xs text-muted-foreground">
                    仅已挂载（运行中）的云存储可刷新实际占用
                  </p>
                )}
              </section>

              <section className="space-y-2 border-t pt-3" data-testid="cloud-storage-archive">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">当前归档</h3>
                  {archiveFailed && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={retrying}
                      onClick={() => { void handleRetryArchive() }}
                    >
                      {retrying ? '重试中...' : '重试归档'}
                    </Button>
                  )}
                </div>
                {!archive ? (
                  <p className="text-sm text-muted-foreground">暂无归档</p>
                ) : (
                  <div className="space-y-2">
                    <DetailRow label="文件名">{archive.fileName}</DetailRow>
                    <DetailRow label="来源">
                      {archive.cloudHostName ?? '手动归档'}
                    </DetailRow>
                    <DetailRow label="大小">{formatStorageBytes(archive.usageBytes)}</DetailRow>
                    <DetailRow label="时间">
                      {formatDateTime(archive.finishedAt ?? archive.startedAt)}
                    </DetailRow>
                    <DetailRow label="状态">
                      <Badge variant={archiveFailed ? 'destructive' : 'outline'}>
                        {cloudStorageArchiveStatusLabel(archive.status)}
                      </Badge>
                    </DetailRow>
                    {archive.failureReason && (
                      <DetailRow label="失败原因">
                        <span className="text-destructive">{archive.failureReason}</span>
                      </DetailRow>
                    )}
                    {archive.status === 'SUCCEEDED' && archive.sourcePvcReleased === false && (
                      <DetailRow label="源卷释放">
                        <span className="text-destructive">
                          源容量卷删除失败（数据已归档，再次挂载时自动清理）
                        </span>
                      </DetailRow>
                    )}
                  </div>
                )}
              </section>

              {restore && (
                <section className="space-y-2 border-t pt-3" data-testid="cloud-storage-restore">
                  <h3 className="text-sm font-medium">当前复原</h3>
                  <DetailRow label="状态">
                    <Badge variant={restoreFailed ? 'destructive' : 'outline'}>
                      {cloudStorageArchiveStatusLabel(restore.status)}
                    </Badge>
                  </DetailRow>
                  <DetailRow label="时间">
                    {formatDateTime(restore.finishedAt ?? restore.startedAt)}
                  </DetailRow>
                  {restore.failureReason && (
                    <DetailRow label="失败原因">
                      <span className="text-destructive">{restore.failureReason}</span>
                    </DetailRow>
                  )}
                  {restoreFailed && (
                    <p className="break-words text-xs text-destructive">
                      {RESTORE_FAILED_DESTROY_WARNING}
                    </p>
                  )}
                </section>
              )}

              {(archivable || restorable || forkable) && (
                <section className="border-t pt-3">
                  <h3 className="mb-2 text-sm font-medium">操作</h3>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {archivable && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setArchiveOpen(true)}
                      >
                        归档
                      </Button>
                    )}
                    {restorable && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setRestoreOpen(true)}
                      >
                        {restoreFailed ? '重试复原' : '复原到归档'}
                      </Button>
                    )}
                    {forkable && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setForkOpen(true)}
                      >
                        fork
                      </Button>
                    )}
                  </div>
                </section>
              )}

              {actionError && (
                <p role="alert" className="break-words text-sm text-destructive">
                  {actionError}
                </p>
              )}

              {archiveFailed && (
                <p className="break-words text-xs text-destructive">
                  {ARCHIVE_FAILED_DESTROY_WARNING}
                </p>
              )}

              {destroyable && (
                <section className="border-t pt-3">
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setDestroyOpen(true)}
                  >
                    销毁云存储
                  </Button>
                </section>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">云存储不存在或已被销毁</p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={destroyOpen}
        onOpenChange={setDestroyOpen}
        title="销毁云存储"
        description={
          restoreFailed
            ? `${RESTORE_FAILED_DESTROY_WARNING}。销毁云存储会删除全部数据与当前归档，且不可恢复，确认销毁？`
            : archiveFailed
              ? `${ARCHIVE_FAILED_DESTROY_WARNING}。销毁云存储会删除全部数据与当前归档，且不可恢复，确认销毁？`
              : '销毁云存储会删除全部数据与当前归档，且不可恢复，确认销毁？'
        }
        confirmLabel="确认销毁"
        loading={destroying}
        onConfirm={handleDestroy}
      />

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="归档云存储"
        description="归档后将释放数据卷并转为半价计费；归档期间存储不可挂载。确认归档？"
        confirmLabel="确认归档"
        loading={actionBusy}
        onConfirm={handleArchive}
      />

      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        title="复原到归档"
        description={`${RESTORE_DESTRUCTIVE_WARNING}。确认从归档重建当前云存储？`}
        confirmLabel="确认复原"
        loading={actionBusy}
        onConfirm={handleRestore}
      />

      <ForkCloudStorageDialog
        open={forkOpen}
        source={storage ?? null}
        onClose={() => setForkOpen(false)}
        onForked={() => { onChanged?.() }}
      />
    </>
  )
}
