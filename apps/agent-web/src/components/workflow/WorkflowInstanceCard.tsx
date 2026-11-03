import { NavLink } from 'react-router-dom'
import type { WorkflowInstanceSummaryData } from '@/graphql/workflow'
import {
  NODE_STATUS_BADGE,
  NODE_STATUS_LABELS,
  instanceStatusText,
} from './WorkflowNodeTreeConstants'

interface WorkflowInstanceCardProps {
  instance: WorkflowInstanceSummaryData
}

/**
 * 工作流卡片（PRD 功能点 7）：
 * 第一行 名称（强调）+ 状态徽标；第二行 工作区名称。控制器名移入 hover tooltip，不再占卡片行。
 */
export default function WorkflowInstanceCard({ instance }: WorkflowInstanceCardProps) {
  const workspaceName = instance.workspace?.name
  const controllerName = instance.controller?.name
  const status = instance.currentNodeNames.length > 0
    ? 'RUNNING'
    : (instance.lastNodeStatus ?? 'INITIALIZING')
  const statusText = instanceStatusText(instance)

  return (
    <li data-testid="workflow-instance-card">
      <NavLink
        to={`/workflows/${instance.id}`}
        title={[controllerName ? `控制器：${controllerName}` : null, statusText]
          .filter(Boolean)
          .join('\n')}
        className={({ isActive }) =>
          `flex items-start gap-2 rounded px-3 py-1.5 text-sm transition-colors ${
            isActive
              ? 'bg-sidebar-accent text-sidebar-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent'
          }`
        }
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {instance.name}
            </span>
            <span
              data-testid="workflow-instance-status"
              data-status={status}
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${NODE_STATUS_BADGE[status]}`}
            >
              {NODE_STATUS_LABELS[status]}
            </span>
          </div>
          <div
            data-testid="workflow-instance-workspace"
            className="truncate text-xs text-muted-foreground"
          >
            {workspaceName ?? <span className="text-muted-foreground/50">未知工作区</span>}
          </div>
        </div>
      </NavLink>
    </li>
  )
}
