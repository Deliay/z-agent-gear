import { useEffect, useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
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
import { Label } from '@/components/ui/label'
import {
  GET_WORKFLOW_INSTANCE,
  COMPLETE_HUMAN_NODE,
  REJECT_NODE,
  type WorkflowInstanceData,
  type WorkflowNodeData,
  type WorkflowNodeStatus,
  type WorkflowNodeType,
} from '@/graphql/workflow'
import { MessageSquare, RotateCcw } from 'lucide-react'

const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  HUMAN: '人类',
  AI: 'AI',
  FLAG: '旗帜',
}

const NODE_STATUS_LABELS: Record<WorkflowNodeStatus, string> = {
  INITIALIZING: '初始化中',
  READY: '待开始',
  RUNNING: '执行中',
  DONE: '已完成',
  REJECT: '已打回',
  REWORK: '返工中',
}

const NODE_STATUS_BADGE: Record<WorkflowNodeStatus, string> = {
  INITIALIZING: 'bg-warning/15 text-warning',
  READY: 'bg-muted text-muted-foreground',
  RUNNING: 'bg-info/15 text-info',
  DONE: 'bg-success/15 text-success',
  REJECT: 'bg-destructive/15 text-destructive',
  REWORK: 'bg-warning/15 text-warning',
}

interface WorkflowNodeTreeProps {
  instance: WorkflowInstanceData
  onOpenSession: (sessionId: string) => void
}

/** 人类节点操作：完成（文本输入）/ 打回（弹框输入理由） */
function HumanNodeActions({
  instanceId,
  node,
}: {
  instanceId: string
  node: WorkflowNodeData
}) {
  // 实例页 5s 轮询期间工作流持续流转，节点状态翻转会使本组件卸载重挂；
  // 输入内容按 instanceId+nodeId 持久化到 localStorage，刷新/重挂后自动恢复，完成/打回后清除。
  const draftKey = `workflow-node-draft:${instanceId}:${node.id}`
  const [input, setInput] = useState(
    () => localStorage.getItem(draftKey) ?? '',
  )
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (input) {
      localStorage.setItem(draftKey, input)
    } else {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey, input])

  const [completeHumanNode] = useMutation(COMPLETE_HUMAN_NODE)
  const [rejectNode] = useMutation(REJECT_NODE)

  const refetch = [{ query: GET_WORKFLOW_INSTANCE, variables: { id: instanceId } }]

  const handleComplete = async () => {
    setSubmitting(true)
    try {
      await completeHumanNode({
        variables: { instanceId, nodeId: node.id, input: input.trim() || null },
        refetchQueries: refetch,
      })
      setInput('')
      localStorage.removeItem(draftKey)
      toast.success('节点已完成')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const handleReject = async () => {
    if (!reason.trim()) return
    setSubmitting(true)
    try {
      await rejectNode({
        variables: { instanceId, nodeId: node.id, reason: reason.trim() },
        refetchQueries: refetch,
      })
      setRejectOpen(false)
      setReason('')
      toast.success('已打回上游节点')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打回失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <textarea
        aria-label={`${node.name} 完成输入`}
        className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="输入内容（将作为节点产物写入黑板，可为空）"
      />
      <div className="flex gap-2">
        <Button size="xs" onClick={handleComplete} disabled={submitting}>
          完成
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setRejectOpen(true)}
          disabled={submitting}
        >
          打回
        </Button>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>打回节点「{node.name}」</DialogTitle>
            <DialogDescription>
              请填写打回理由，上游节点将收到理由并返工修正。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>打回理由</Label>
            <textarea
              aria-label="打回理由"
              className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="请说明打回原因"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={!reason.trim() || submitting}
            >
              确认打回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function WorkflowNodeTree({ instance, onOpenSession }: WorkflowNodeTreeProps) {
  const stages: string[] = []
  for (const node of instance.nodes) {
    if (!stages.includes(node.stage)) stages.push(node.stage)
  }

  return (
    <div className="space-y-6">
      {stages.map((stage) => (
        <div key={stage}>
          <h3 className="mb-2 text-sm font-semibold text-foreground">{stage}</h3>
          <div className="space-y-2">
            {instance.nodes
              .filter((node) => node.stage === stage)
              .map((node) => (
                <div key={node.id} className="rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{NODE_TYPE_LABELS[node.type]}</Badge>
                    <span className="flex-1 truncate text-sm font-medium">{node.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${NODE_STATUS_BADGE[node.status]}`}
                    >
                      {NODE_STATUS_LABELS[node.status]}
                    </span>
                    {node.reworkCount > 0 && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <RotateCcw className="size-3" />
                        返工 {node.reworkCount} 次
                      </span>
                    )}
                    {node.sessionId && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => onOpenSession(node.sessionId!)}
                      >
                        <MessageSquare className="size-3" />
                        会话
                      </Button>
                    )}
                  </div>
                  {node.description && (
                    <p className="mt-1 text-xs text-muted-foreground">{node.description}</p>
                  )}
                  {node.rejectInfo && node.status === 'REJECT' && (
                    <p className="mt-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
                      打回理由：{node.rejectInfo.reason}
                    </p>
                  )}
                  {node.type === 'HUMAN' &&
                    (node.status === 'READY' || node.status === 'RUNNING') && (
                      <HumanNodeActions instanceId={instance.id} node={node} />
                    )}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}
