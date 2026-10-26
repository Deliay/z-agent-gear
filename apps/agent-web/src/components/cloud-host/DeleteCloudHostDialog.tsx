import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import {
  CLEANUP_CLOUD_HOST_ISSUES_LABELS,
  DELETE_CLOUD_HOST,
} from '../../graphql/mutations'
import { CLOUD_HOST_ISSUES_LINKAGES } from '../../graphql/queries'
import type {
  CleanupCloudHostIssuesLabelsMutation,
  CloudHostData,
  CloudHostIssuesLinkagesQuery,
  DeleteCloudHostMutation,
} from '../../graphql/types'
import { canDeleteCloudHost, cloudHostStatusLabel } from './cloud-host-status'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface DeleteCloudHostDialogProps {
  open: boolean
  cloudHost: Pick<CloudHostData, 'id' | 'name' | 'status' | 'deletedAt'>
  /** 用于查询联动配置（缺失时不展示标签清理勾选项） */
  controllerId?: string
  onClose: () => void
  onDeleted: () => void
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return '删除云电脑失败，请稍后重试'
}

/**
 * 删除云电脑：仅 STOPPED/FAILED 可删除（软删除，历史会话保留）。
 * 运行中/停止中由服务端拒绝，前端不展示删除入口。
 */
export default function DeleteCloudHostDialog({
  open,
  cloudHost,
  controllerId,
  onClose,
  onDeleted,
}: DeleteCloudHostDialogProps) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cleanupLabels, setCleanupLabels] = useState(false)
  const [cleanupDone, setCleanupDone] = useState(false)
  const [failedLabels, setFailedLabels] = useState<string[]>([])
  const [deleteCloudHost] = useMutation<DeleteCloudHostMutation>(DELETE_CLOUD_HOST)
  const [cleanupIssuesLabels] = useMutation<CleanupCloudHostIssuesLabelsMutation>(
    CLEANUP_CLOUD_HOST_ISSUES_LABELS,
  )
  const deletable = canDeleteCloudHost(cloudHost)
  const { data: linkagesData } = useQuery<CloudHostIssuesLinkagesQuery>(
    CLOUD_HOST_ISSUES_LINKAGES,
    {
      variables: { controllerId: controllerId ?? '' },
      skip: !open || !deletable || !controllerId,
      errorPolicy: 'ignore',
    },
  )
  const linkageCount = linkagesData?.cloudHostIssuesLinkages.length ?? 0

  useEffect(() => {
    if (open) {
      setDeleting(false)
      setError(null)
      setCleanupLabels(false)
      setCleanupDone(false)
      setFailedLabels([])
    }
  }, [open])

  const handleDelete = async () => {
    if (!deletable || deleting) return
    setDeleting(true)
    setError(null)
    if (cleanupLabels && controllerId && !cleanupDone) {
      try {
        const { data } = await cleanupIssuesLabels({ variables: { controllerId } })
        const failed = data?.cleanupCloudHostIssuesLabels.failed ?? []
        setCleanupDone(true)
        if (failed.length > 0) {
          setFailedLabels(failed)
          setDeleting(false)
          return
        }
      } catch {
        setFailedLabels(['清理标签失败，可重试或直接删除'])
        setDeleting(false)
        return
      }
    }
    try {
      await deleteCloudHost({ variables: { id: cloudHost.id } })
      onDeleted()
    } catch (err) {
      setError(getErrorMessage(err))
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除云电脑</DialogTitle>
          <DialogDescription>
            {cloudHost.name}
          </DialogDescription>
        </DialogHeader>

        {deletable ? (
          <p className="text-sm text-muted-foreground">
            删除后云电脑将从主机列表移除，历史会话保留但不可再运行。确认删除？
          </p>
        ) : (
          <p className="text-sm text-destructive">
            当前状态（{cloudHostStatusLabel(cloudHost.status)}）不可删除，请先停止云电脑。
          </p>
        )}

        {deletable && linkageCount > 0 && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="同时删除已同步到仓库的标签"
              checked={cleanupLabels}
              onChange={(event) => setCleanupLabels(event.target.checked)}
            />
            <span>同时删除已同步到仓库的标签（{linkageCount} 条配置）</span>
          </label>
        )}

        {failedLabels.length > 0 && (
          <div role="alert" className="rounded-md bg-muted p-2 text-sm text-destructive">
            <p>以下标签清理失败（不影响删除云电脑）：</p>
            <ul className="mt-1 list-disc pl-5">
              {failedLabels.map((item) => (
                <li key={item} className="break-all">{item}</li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={deleting}>
            取消
          </Button>
          {deletable && (
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => { void handleDelete() }}
            >
              {deleting ? '删除中...' : failedLabels.length > 0 ? '仍要删除' : '确认删除'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
