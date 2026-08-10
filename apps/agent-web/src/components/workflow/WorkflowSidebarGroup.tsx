import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import {
  GET_WORKFLOW_INSTANCES,
  type GetWorkflowInstancesQuery,
} from '@/graphql/workflow'
import InstantiateWorkflowDialog from './InstantiateWorkflowDialog'
import { Workflow, Plus } from 'lucide-react'

interface WorkflowSidebarGroupProps {
  workspaceId: string
  controllerId: string
}

/** 侧边栏工作区节点下的「工作流」分组：实例列表 + 「+」实例化入口 */
export default function WorkflowSidebarGroup({
  workspaceId,
  controllerId,
}: WorkflowSidebarGroupProps) {
  const [showInstantiate, setShowInstantiate] = useState(false)
  const { data } = useQuery<GetWorkflowInstancesQuery>(GET_WORKFLOW_INSTANCES, {
    variables: { workspaceId },
    pollInterval: 15000,
  })

  const instances = data?.workflowInstances ?? []

  return (
    <li>
      <div className="flex items-center gap-2 rounded px-3 py-1.5 text-sm">
        <Workflow className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-left text-muted-foreground">工作流</span>
        <button
          type="button"
          aria-label="实例化工作流"
          title="实例化工作流"
          className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => setShowInstantiate(true)}
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {instances.length > 0 && (
        <ul className="ml-4 space-y-1">
          {instances.map((instance) => (
            <li key={instance.id}>
              <NavLink
                to={`/workflows/${instance.id}`}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-foreground'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent'
                  }`
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{instance.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {instance.currentNodeNames.length > 0
                      ? `执行中：${instance.currentNodeNames.join('、')}`
                      : '暂无执行中的节点'}
                  </div>
                </div>
              </NavLink>
            </li>
          ))}
        </ul>
      )}

      <InstantiateWorkflowDialog
        open={showInstantiate}
        onOpenChange={setShowInstantiate}
        workspaceId={workspaceId}
        controllerId={controllerId}
      />
    </li>
  )
}
