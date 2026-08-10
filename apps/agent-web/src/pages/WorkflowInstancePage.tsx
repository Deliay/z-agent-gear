import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
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
  })

  const instance = data?.workflowInstance

  if (loading) {
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
