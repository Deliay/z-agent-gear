import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  GET_WORKFLOW_INSTANCE,
  type GetWorkflowInstanceQuery,
} from '@/graphql/workflow'
import WorkflowNodeTree from '@/components/workflow/WorkflowNodeTree'
import BlackboardPanel from '@/components/workflow/BlackboardPanel'
import SessionSidePanel from '@/components/workflow/SessionSidePanel'
import MobileBackButton from '@/components/MobileBackButton'
import { Badge } from '@/components/ui/badge'

export default function WorkflowInstancePage() {
  const { id } = useParams<{ id: string }>()
  const [sideSessionId, setSideSessionId] = useState<string | null>(null)

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
    </div>
  )
}
