import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  GET_WORKFLOW_INSTANCE,
  DELETE_WORKFLOW_INSTANCE,
  type GetWorkflowInstanceQuery,
} from '@/graphql/workflow'
import WorkflowNodeTree from '@/components/workflow/WorkflowNodeTree'
import BlackboardPanel from '@/components/workflow/BlackboardPanel'
import SessionSidePanel from '@/components/workflow/SessionSidePanel'
import MobileBackButton from '@/components/MobileBackButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Trash2 } from 'lucide-react'

export default function WorkflowInstancePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [sideSessionId, setSideSessionId] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteWorkflowInstance] = useMutation(DELETE_WORKFLOW_INSTANCE)

  const { data, loading } = useQuery<GetWorkflowInstanceQuery>(GET_WORKFLOW_INSTANCE, {
    variables: { id: id ?? '' },
    skip: !id,
    pollInterval: 5000,
    // Apollo v4 默认 notifyOnNetworkStatusChange=true：轮询会反复置 loading，
    // 导致整页卸载成 spinner、打断用户输入；轮询期间保持渲染现有内容。
    notifyOnNetworkStatusChange: false,
  })

  const instance = data?.workflowInstance
  const nodes = instance?.nodes

  // 失败节点强提醒：toast 每个节点仅一次（轮询会反复返回同一失败状态）
  const toastedFailedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!nodes) return
    for (const node of nodes) {
      if (node.status === 'FAILED' && !toastedFailedRef.current.has(node.id)) {
        toastedFailedRef.current.add(node.id)
        toast.error(`工作流节点「${node.name}」失败，需要人工介入`, { duration: 10000 })
      }
    }
  }, [nodes])

  if (loading && !instance) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      </div>
    )
  }

  if (!instance) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">工作流实例不存在</p>
      </div>
    )
  }

  const failedNodes = instance.nodes.filter((node) => node.status === 'FAILED')

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteWorkflowInstance({ variables: { id: instance.id } })
      toast.success('工作流实例已删除')
      navigate('/sessions')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
      setDeleting(false)
      setDeleteOpen(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="mb-4 flex items-center gap-2">
        <MobileBackButton to="/sessions" />
        <h1 className="text-xl font-bold">{instance.name}</h1>
        {instance.currentNodeNames.length > 0 ? (
          instance.currentNodeNames.map((name) => (
            <Badge key={name} variant="default">
              执行中：{name}
            </Badge>
          ))
        ) : (
          <Badge variant="secondary">暂无执行中的节点</Badge>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="size-3.5" />
          删除实例
        </Button>
      </div>

      {failedNodes.length > 0 && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3"
        >
          <p className="text-sm font-semibold text-destructive">
            ⚠️ {failedNodes.length} 个节点失败，流程已阻断，需要人工介入
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-destructive/90">
            {failedNodes.map((node) => (
              <li key={node.id}>
                「{node.name}」：{node.failInfo?.reason || '未提供失败原因'}
                （打开节点会话给出处理指示，AI 确认后会恢复节点运行）
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <WorkflowNodeTree instance={instance} onOpenSession={setSideSessionId} />
        <BlackboardPanel
          blackboard={instance.blackboard}
          trash={instance.blackboardTrash}
        />
      </div>

      <SessionSidePanel
        sessionId={sideSessionId}
        onClose={() => setSideSessionId(null)}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除工作流实例「{instance.name}」？</DialogTitle>
            <DialogDescription>
              删除将停止流程运转，并删除全部节点会话（含进行中的 AI 会话与 worktree）。
              实例数据会保留为已删除标记，不再出现在列表中，且无法继续流转。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? '删除中…' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
