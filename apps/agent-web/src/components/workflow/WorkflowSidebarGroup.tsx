import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import {
  GET_WORKFLOW_INSTANCES,
  type GetWorkflowInstancesQuery,
  type WorkflowInstanceSummaryData,
} from '@/graphql/workflow'
import { instanceStatusText } from './WorkflowNodeTreeConstants'
import InstantiateWorkflowDialog from './InstantiateWorkflowDialog'
import { Archive, ChevronDown, ChevronRight, Workflow, Plus } from 'lucide-react'

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
  const [archivedOpen, setArchivedOpen] = useState(false)
  const { data } = useQuery<GetWorkflowInstancesQuery>(GET_WORKFLOW_INSTANCES, {
    variables: { workspaceId },
    pollInterval: 15000,
  })
  const { data: archivedData } = useQuery<GetWorkflowInstancesQuery>(GET_WORKFLOW_INSTANCES, {
    variables: { workspaceId, archived: true },
    pollInterval: 15000,
  })

  const instances = data?.workflowInstances ?? []
  const archivedInstances = archivedData?.workflowInstances ?? []

  const renderItem = (instance: WorkflowInstanceSummaryData) => (
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
            {instanceStatusText(instance)}
          </div>
        </div>
      </NavLink>
    </li>
  )

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
          {instances.map(renderItem)}
        </ul>
      )}

      {archivedInstances.length > 0 && (
        <div className="ml-4">
          <button
            type="button"
            className="flex items-center gap-1 rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setArchivedOpen((prev) => !prev)}
            aria-expanded={archivedOpen}
          >
            {archivedOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            <Archive className="size-3" />
            已归档（{archivedInstances.length}）
          </button>
          {archivedOpen && (
            <ul className="space-y-1">
              {archivedInstances.map(renderItem)}
            </ul>
          )}
        </div>
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
