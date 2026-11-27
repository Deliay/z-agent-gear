import { NavLink, useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import type { WorkflowInstanceSummaryData, WorkflowInstanceUnavailableReason } from '@/graphql/workflow'
import {
  NODE_STATUS_BADGE,
  NODE_STATUS_LABELS,
  instanceStatusText,
} from './WorkflowNodeTreeConstants'
import { workflowNodeStatusVisual } from '@/lib/status-matrix'

interface WorkflowInstanceCardProps {
  instance: WorkflowInstanceSummaryData
}

/** 不可用原因文案（未知值防御式回退为离线口径） */
function unavailableReasonLabel(reason: WorkflowInstanceUnavailableReason | undefined): string {
  return reason === 'CONTROLLER_DELETED' ? '控制器已删除' : '控制器离线'
}

/**
 * 工作流卡片（PRD 功能点 7）：
 * 第一行 名称（强调）+（不可用徽标）+ 状态徽标；第二行 工作区名称。控制器名移入 hover tooltip。
 * 不可用实例额外提供「接续」图标入口：不嵌套进 NavLink（保持导航语义），点击跳转 `?continue=1`。
 */
export default function WorkflowInstanceCard({ instance }: WorkflowInstanceCardProps) {
  const navigate = useNavigate()
  const workspaceName = instance.workspace?.name
  const controllerName = instance.controller?.name
  const status = instance.currentNodeNames.length > 0
    ? 'RUNNING'
    : (instance.lastNodeStatus ?? 'INITIALIZING')
  const statusText = instanceStatusText(instance)
  const statusVisual = workflowNodeStatusVisual(status)
  const unavailable = Boolean(instance.unavailableReason)

  const handleContinue = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    navigate(`/workflows/${instance.id}?continue=1`)
  }

  return (
    <li data-testid="workflow-instance-card" className="relative">
      <NavLink
        to={`/workflows/${instance.id}`}
        title={[controllerName ? `控制器：${controllerName}` : null, statusText]
          .filter(Boolean)
          .join('\n')}
        className={({ isActive }) =>
          `flex items-start gap-2 rounded px-3 py-1.5 text-sm transition-colors ${
            unavailable ? 'pr-9' : ''
          } ${
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
            {unavailable && (
              <span
                data-testid="workflow-instance-unavailable"
                data-reason={instance.unavailableReason ?? undefined}
                className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
              >
                {unavailableReasonLabel(instance.unavailableReason)}
              </span>
            )}
            <span
              data-testid="workflow-instance-status-dot"
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${statusVisual.dot}`}
            />
            <span
              data-testid="workflow-instance-status"
              data-status={status}
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${NODE_STATUS_BADGE[status]}`}
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
      {unavailable && (
        <button
          type="button"
          aria-label="接续工作流"
          title="接续工作流"
          data-testid="workflow-instance-continue"
          onClick={handleContinue}
          className="absolute right-1.5 top-1 rounded p-1 text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="size-3.5" />
        </button>
      )}
    </li>
  )
}
