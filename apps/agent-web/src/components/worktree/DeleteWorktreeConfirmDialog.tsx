import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { WORKSPACE_WORKTREES } from '@/graphql/queries'
import { DELETE_WORKTREE } from '@/graphql/mutations'
import type { DeleteWorktreeMutation } from '@/graphql/types'

interface DeleteWorktreeConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  controllerId: string
  workspaceId: string
  worktreePath: string
  sessionCount: number
  workspaceName?: string
}

export default function DeleteWorktreeConfirmDialog({
  open,
  onOpenChange,
  controllerId,
  workspaceId,
  worktreePath,
  sessionCount,
}: DeleteWorktreeConfirmDialogProps) {
  const [deleting, setDeleting] = useState(false)

  const [deleteWorktree] = useMutation<DeleteWorktreeMutation>(DELETE_WORKTREE)

  const branchName = worktreePath.split('/').filter(Boolean).pop() || worktreePath

  const handleConfirm = async () => {
    setDeleting(true)
    try {
      const { data } = await deleteWorktree({
        variables: { controllerId, workspaceId, worktreePath },
        refetchQueries: [{ query: WORKSPACE_WORKTREES, variables: { controllerId, workspaceId } }],
      })

      if (data?.deleteWorktree?.success) {
        toast.success('Worktree 已删除')
        onOpenChange(false)
      } else {
        const errMsg = data?.deleteWorktree?.error || '删除失败'
        toast.error(errMsg)
      }
    } catch {
      toast.error('删除 Worktree 失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认删除 Worktree</DialogTitle>
          <DialogDescription>
            确定要删除 <span className="font-medium text-foreground">{branchName}</span> 吗？此操作将
            <span className="text-destructive font-medium"> 彻底删除 </span>
            worktree 及其关联数据，且
            <span className="text-destructive font-medium"> 不可恢复</span>。
          </DialogDescription>
        </DialogHeader>

        {sessionCount > 0 && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            此 worktree 关联了 {sessionCount} 个会话，它们将被关闭。
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            取消
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={deleting}>
            {deleting ? '删除中...' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
