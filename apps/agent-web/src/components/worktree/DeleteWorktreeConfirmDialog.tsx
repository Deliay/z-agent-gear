import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useLocation, useNavigate } from 'react-router-dom'
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
  workspaceName,
}: DeleteWorktreeConfirmDialogProps) {
  const [deleting, setDeleting] = useState(false)

  const [deleteWorktree] = useMutation<DeleteWorktreeMutation>(DELETE_WORKTREE)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const branchName = worktreePath.split('/').filter(Boolean).pop() || worktreePath

  const handleConfirm = async () => {
    setDeleting(true)
    try {
      const { data } = await deleteWorktree({
        variables: { controllerId, workspaceId, worktreePath },
        refetchQueries: [{ query: WORKSPACE_WORKTREES, variables: { controllerId, workspaceId } }],
      })

      const result = data?.deleteWorktree
      const failures = result?.failures ?? []
      const failureDetail = failures.map((f) => `${f.sessionId}：${f.error}`).join('；')

      if (result?.success && failures.length === 0) {
        toast.success('Worktree 已删除')
      } else if (result?.success) {
        toast.warning(`Worktree 已删除，但部分清理失败：${failureDetail}`)
      } else {
        const errMsg = result?.error || (failureDetail ? `删除失败：${failureDetail}` : '删除失败')
        toast.error(errMsg)
        return
      }

      // 删除成功后若停留在被关闭会话的页面，跳转回首页
      const closedSessionIds = result?.closedSessionIds ?? []
      if (closedSessionIds.some((id) => pathname === `/sessions/${id}`)) {
        navigate('/')
      }
      onOpenChange(false)
    } catch {
      toast.error('删除 Worktree 失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!deleting) onOpenChange(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认删除 Worktree</DialogTitle>
          <DialogDescription>
            确定要删除{workspaceName ? <> Workspace <span className="font-medium text-foreground">{workspaceName}</span> 下的</> : ''} worktree <span className="font-medium text-foreground">{branchName}</span> 吗？此操作将
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
