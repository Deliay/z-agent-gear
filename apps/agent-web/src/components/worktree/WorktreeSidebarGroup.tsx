import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { WorkspaceWorktreeData, ControllerData, SessionData } from '@/graphql/types'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import DeleteWorktreeConfirmDialog from './DeleteWorktreeConfirmDialog'
import NewSessionDialog from '@/components/session/NewSessionDialog'
import InstantiateWorkflowDialog from '@/components/workflow/InstantiateWorkflowDialog'
import { getStatusDotColor } from '@/components/session/status-colors'
import {
  ChevronDown,
  ChevronRight,
  GitFork,
  Plus,
  Trash2,
} from 'lucide-react'

interface WorktreeSidebarGroupProps {
  workspaceId: string
  controllerId: string
  workspaceName: string
  controllers: ControllerData[]
  /** 由 homeOverview.workspaces.worktrees 下传的 Worktree 列表（纯展示，不再独立查询） */
  worktrees: WorkspaceWorktreeData[]
  /** worktree 会话平铺展示的回退数据（无 worktree 时使用） */
  fallbackSessions: SessionData[]
  onCreate: (controllerId: string, acpServerType: string, workspaceId: string, enableWorktree?: boolean, worktreeBranchSuffix?: string, mcpServerIds?: string[], existingWorktreePath?: string) => void
}

export default function WorktreeSidebarGroup({
  workspaceId,
  controllerId,
  workspaceName,
  controllers,
  worktrees,
  fallbackSessions,
  onCreate,
}: WorktreeSidebarGroupProps) {
  const [expandedWorktrees, setExpandedWorktrees] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceWorktreeData | null>(null)
  const [showNewSession, setShowNewSession] = useState(false)
  const [showInstantiateWorkflow, setShowInstantiateWorkflow] = useState(false)
  const [newSessionWorktreePath, setNewSessionWorktreePath] = useState<string | undefined>()

  const toggleWorktree = (path: string) => {
    setExpandedWorktrees((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const handleNewSessionInWorktree = (worktreePath: string) => {
    setNewSessionWorktreePath(worktreePath)
    setShowNewSession(true)
  }

  const getBranchDisplay = (wt: WorkspaceWorktreeData) => {
    return wt.branch || wt.path.split('/').filter(Boolean).pop() || 'unknown'
  }

  // 场景 1：存在 worktree - 正常渲染 worktree 列表
  if (worktrees.length > 0) {
    return (
      <>
        {worktrees.map((wt) => {
          const isExpanded = expandedWorktrees.has(wt.path)

          return (
            <li key={wt.path}>
              <div className="flex items-center gap-2 rounded px-3 py-1.5 text-sm">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onClick={() => toggleWorktree(wt.path)}
                >
                  <span className="text-xs text-muted-foreground">
                    {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  </span>
                  <GitFork className="size-3 shrink-0 text-info" />
                  <span className="truncate text-left text-sidebar-foreground">
                    {getBranchDisplay(wt)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {wt.sessionCount}
                  </span>
                </button>

                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label="添加"
                  >
                    <Plus className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuPopup>
                    <DropdownMenuItem onClick={() => handleNewSessionInWorktree(wt.path)}>
                      新建会话
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setShowInstantiateWorkflow(true)}>
                      实例化工作流
                    </DropdownMenuItem>
                  </DropdownMenuPopup>
                </DropdownMenu>

                <button
                  type="button"
                  className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-destructive"
                  aria-label="删除 Worktree"
                  onClick={() => setDeleteTarget(wt)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>

              {isExpanded && wt.sessions.length > 0 && (
                <ul className="ml-4 space-y-1">
                  {wt.sessions.map((session) => (
                    <li key={session.id}>
                      <NavLink
                        to={`/sessions/${session.id}`}
                        className={({ isActive }) =>
                          `flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors ${
                            isActive
                              ? 'bg-sidebar-accent text-sidebar-foreground'
                              : 'text-sidebar-foreground hover:bg-sidebar-accent'
                          }`
                        }
                      >
                        <span className={`h-2 w-2 shrink-0 rounded-full ${getStatusDotColor(session.status)}`} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">
                            {session.title || 'New Session'}
                          </div>
                        </div>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}

        {deleteTarget && (
          <DeleteWorktreeConfirmDialog
            open={!!deleteTarget}
            onOpenChange={(open) => {
              if (!open) setDeleteTarget(null)
            }}
            controllerId={controllerId}
            workspaceId={workspaceId}
            worktreePath={deleteTarget.path}
            sessionCount={deleteTarget.sessionCount}
            workspaceName={workspaceName}
          />
        )}

        {showNewSession && (
          <NewSessionDialog
            controllers={controllers}
            onClose={() => {
              setShowNewSession(false)
              setNewSessionWorktreePath(undefined)
            }}
            onCreate={(controllerId, acpServerType, workspaceId, enableWorktree, worktreeBranchSuffix, mcpServerIds, existingWorktreePath) => {
              onCreate(controllerId, acpServerType, workspaceId, enableWorktree, worktreeBranchSuffix, mcpServerIds, existingWorktreePath ?? newSessionWorktreePath)
              setShowNewSession(false)
              setNewSessionWorktreePath(undefined)
            }}
            existingWorktreePath={newSessionWorktreePath}
            existingControllerId={controllerId}
            existingWorkspaceId={workspaceId}
          />
        )}

        <InstantiateWorkflowDialog
          open={showInstantiateWorkflow}
          onOpenChange={setShowInstantiateWorkflow}
          workspaceId={workspaceId}
          controllerId={controllerId}
        />
      </>
    )
  }

  // 场景 2：无 worktree - 显示默认工作区条目
  return (
    <>
      <li>
        <div className="flex items-center gap-2 rounded px-3 py-1.5 text-sm">
          <GitFork className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-left text-muted-foreground">
            {workspaceName}（默认）
          </span>
        </div>
      </li>
      {fallbackSessions.map((session) => (
        <li key={session.id} className="ml-4">
          <NavLink
            to={`/sessions/${session.id}`}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors ${
                isActive
                  ? 'bg-sidebar-accent text-sidebar-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent'
              }`
            }
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${getStatusDotColor(session.status)}`} />
            <div className="min-w-0 flex-1">
              <div className="truncate">
                {session.title || 'New Session'}
              </div>
            </div>
          </NavLink>
        </li>
      ))}
    </>
  )
}