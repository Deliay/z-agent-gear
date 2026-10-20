import { useEffect, useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { DELETE_CLOUD_HOST } from '../../graphql/mutations'
import type { CloudHostData, DeleteCloudHostMutation } from '../../graphql/types'
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
  onClose,
  onDeleted,
}: DeleteCloudHostDialogProps) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteCloudHost] = useMutation<DeleteCloudHostMutation>(DELETE_CLOUD_HOST)

  useEffect(() => {
    if (open) {
      setDeleting(false)
      setError(null)
    }
  }, [open])

  const deletable = canDeleteCloudHost(cloudHost)

  const handleDelete = async () => {
    if (!deletable || deleting) return
    setDeleting(true)
    setError(null)
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
              {deleting ? '删除中...' : '确认删除'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
