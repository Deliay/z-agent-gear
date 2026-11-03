import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { CLOUD_STORAGES } from '@/graphql/queries'
import { DESTROY_CLOUD_STORAGE } from '@/graphql/mutations'
import type {
  CloudStorageData,
  DestroyCloudStorageMutation,
  GetCloudStoragesQuery,
} from '@/graphql/types'
import {
  ARCHIVE_FAILED_DESTROY_WARNING,
  canDestroyCloudStorage,
  cloudStorageStatusBadgeVariant,
  cloudStorageStatusLabel,
  formatStorageBytes,
  hasFailedArchive,
  isDestroyedStorageStatus,
} from '@/lib/cloud-storage'
import { formatDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import NewCloudStorageDialog from './NewCloudStorageDialog'
import CloudStorageDetailDialog from './CloudStorageDetailDialog'

const SERVER_ERROR_MESSAGES: Record<string, string> = {
  'storage is not destroyable': '当前状态不可销毁云存储',
  'storage is archiving': '归档仍在进行中，暂不可销毁',
  'storage is attached': '云存储仍被云电脑挂载，无法销毁',
  'not allowed to destroy storage': '没有销毁该云存储的权限',
  'insufficient balance': '账户余额不足，请联系管理员充值后重试',
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim()
    return SERVER_ERROR_MESSAGES[message] ?? message
  }
  return '操作失败，请稍后重试'
}

function StorageRow({ storage, onDetail, onDestroy }: {
  storage: CloudStorageData
  onDetail: () => void
  onDestroy: () => void
}) {
  const destroyable = canDestroyCloudStorage(storage)
  return (
    <li
      className="min-w-0 rounded-lg border border-border p-3"
      data-testid={`cloud-storage-item-${storage.id}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium">{storage.name}</span>
        <Badge variant={cloudStorageStatusBadgeVariant(storage.status)} className="shrink-0">
          {cloudStorageStatusLabel(storage.status)}
        </Badge>
        <span className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`查看 ${storage.name} 详情`}
            onClick={onDetail}
          >
            详情
          </Button>
          {destroyable && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              aria-label={`销毁 ${storage.name}`}
              onClick={onDestroy}
            >
              销毁
            </Button>
          )}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div>容量：<span className="text-foreground">{storage.sizeGi}Gi</span></div>
        <div>
          实际占用：
          <span className="text-foreground">{formatStorageBytes(storage.usageBytes)}</span>
          {storage.usageUpdatedAt ? `（${formatDateTime(storage.usageUpdatedAt)} 更新）` : ''}
        </div>
        <div>
          每小时费用：<span className="text-foreground">{storage.hourlyCredits} credits</span>
        </div>
        <div>创建人：<span className="text-foreground">{storage.createdBy.name}</span></div>
        <div>创建时间：<span className="text-foreground">{formatDateTime(storage.createdAt)}</span></div>
        <div>
          挂载的云电脑：
          <span className="text-foreground">{storage.attachedCloudHostName ?? '无'}</span>
        </div>
      </dl>
    </li>
  )
}

function DestroyedStorageRow({ storage }: { storage: CloudStorageData }) {
  const failed = storage.status === 'CREATE_FAILED'
  return (
    <div
      className="min-w-0 rounded-lg border border-border p-3 text-xs text-muted-foreground"
      data-testid={`destroyed-cloud-storage-${storage.id}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium text-foreground">
          {storage.name}
        </span>
        <Badge variant={cloudStorageStatusBadgeVariant(storage.status)} className="shrink-0">
          {cloudStorageStatusLabel(storage.status)}
        </Badge>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        <div>容量：{storage.sizeGi}Gi</div>
        <div>创建人：{storage.createdBy.name}</div>
        <div>
          {failed ? '失败时间' : '销毁时间'}：
          {formatDateTime(storage.destroyedAt)}
        </div>
        {failed && storage.failureReason && (
          <div className="min-w-0 break-words text-destructive">
            失败原因：{storage.failureReason}
          </div>
        )}
      </dl>
    </div>
  )
}

/**
 * 设置页「云存储」区块：主列表 + 「已销毁」折叠区（默认折叠、无操作入口）。
 * 工作区隔离由服务端 `x-workspace-id` 上下文保证，前端只查询当前工作区数据。
 */
export default function CloudStorageSection() {
  const [showDestroyed, setShowDestroyed] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [destroyTarget, setDestroyTarget] = useState<CloudStorageData | null>(null)
  const [destroying, setDestroying] = useState(false)
  const [destroyError, setDestroyError] = useState<string | null>(null)

  const mainQuery = useQuery<GetCloudStoragesQuery>(CLOUD_STORAGES, {
    variables: { onlyAttachable: false, includeDestroyed: false },
    fetchPolicy: 'cache-and-network',
  })
  const destroyedQuery = useQuery<GetCloudStoragesQuery>(CLOUD_STORAGES, {
    variables: { onlyAttachable: false, includeDestroyed: true },
    skip: !showDestroyed,
    fetchPolicy: 'cache-and-network',
  })
  const [destroyStorage] = useMutation<DestroyCloudStorageMutation>(DESTROY_CLOUD_STORAGE)

  const storages = mainQuery.data?.cloudStorages ?? []
  const destroyedStorages = (destroyedQuery.data?.cloudStorages ?? []).filter((storage) =>
    isDestroyedStorageStatus(storage.status),
  )
  const loading = mainQuery.loading && !mainQuery.data

  const refetchAll = async () => {
    await mainQuery.refetch()
    if (showDestroyed) await destroyedQuery.refetch()
  }

  const handleDestroy = async () => {
    const target = destroyTarget
    if (!target || destroying) return
    setDestroying(true)
    setDestroyError(null)
    try {
      await destroyStorage({ variables: { id: target.id } })
      setDestroyTarget(null)
      toast.success('云存储已销毁')
      await refetchAll()
    } catch (err) {
      setDestroyError(getErrorMessage(err))
    } finally {
      setDestroying(false)
    }
  }

  const archiveFailedDestroy = hasFailedArchive(destroyTarget)

  return (
    <section className="min-w-0 space-y-4 border-t pt-6" data-testid="cloud-storage-section">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-lg font-medium text-foreground">云存储</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            云存储归属当前工作区，创建成功即开始按小时计费；销毁云电脑时自动归档。
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          新建云存储
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">正在加载云存储...</p>
      ) : mainQuery.error && !mainQuery.data ? (
        <div className="space-y-2">
          <p role="alert" className="break-words text-sm text-destructive">
            云存储加载失败：{getErrorMessage(mainQuery.error)}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => { void mainQuery.refetch() }}>
            重试
          </Button>
        </div>
      ) : storages.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm font-medium text-foreground">暂无云存储</p>
          <p className="mt-1 text-xs text-muted-foreground">
            创建云存储后可在新建云电脑时挂载为 /home/worker 主目录。
          </p>
          <Button type="button" className="mt-3" onClick={() => setCreateOpen(true)}>
            新建云存储
          </Button>
        </div>
      ) : (
        <ul className="min-w-0 space-y-2">
          {storages.map((storage) => (
            <StorageRow
              key={storage.id}
              storage={storage}
              onDetail={() => setDetailId(storage.id)}
              onDestroy={() => {
                setDestroyError(null)
                setDestroyTarget(storage)
              }}
            />
          ))}
        </ul>
      )}

      <div className="border-t pt-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={showDestroyed}
          onClick={() => setShowDestroyed((prev) => !prev)}
        >
          {showDestroyed ? '收起已销毁' : '已销毁'}
          {showDestroyed && destroyedStorages.length > 0 ? `（${destroyedStorages.length}）` : ''}
        </Button>
        {showDestroyed && (
          <div
            role="region"
            aria-label="已销毁的云存储"
            data-testid="destroyed-cloud-storages"
            className="mt-2 space-y-2"
          >
            {destroyedQuery.loading && !destroyedQuery.data ? (
              <p className="text-sm text-muted-foreground">正在加载已销毁记录...</p>
            ) : destroyedStorages.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无已销毁的云存储</p>
            ) : (
              destroyedStorages.map((storage) => (
                <DestroyedStorageRow key={storage.id} storage={storage} />
              ))
            )}
          </div>
        )}
      </div>

      {destroyError && (
        <p role="alert" className="break-words text-sm text-destructive">
          {destroyError}
        </p>
      )}

      <NewCloudStorageDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false)
          void refetchAll()
        }}
      />

      <CloudStorageDetailDialog
        open={detailId !== null}
        storageId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => { void refetchAll() }}
      />

      <ConfirmDialog
        open={destroyTarget !== null}
        onOpenChange={(open) => !open && setDestroyTarget(null)}
        title="销毁云存储"
        description={
          archiveFailedDestroy
            ? `${ARCHIVE_FAILED_DESTROY_WARNING}。销毁云存储会删除全部数据与当前归档，且不可恢复，确认销毁？`
            : '销毁云存储会删除全部数据与当前归档，且不可恢复，确认销毁？'
        }
        confirmLabel="确认销毁"
        loading={destroying}
        onConfirm={handleDestroy}
      />
    </section>
  )
}
