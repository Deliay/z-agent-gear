import { useState, useEffect, useCallback, useRef } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@apollo/client/react';
import { GET_SESSIONS, GET_CONTROLLERS, GET_WORKSPACES } from '../graphql/queries';
import { CREATE_SESSION } from '../graphql/mutations';
import type {
  GetSessionsQuery,
  GetControllersQuery,
  GetWorkspacesQuery,
  CreateSessionMutation,
  SessionData,
} from '../graphql/types';
import NewSessionDialog from './session/NewSessionDialog';
import { getStatusDotColor } from './session/status-colors';
import WorktreeSidebarGroup from './worktree/WorktreeSidebarGroup';
import { TodoListPanel } from './TodoListPanel';
import ThemeToggle from './ThemeToggle';
import GatewaySection from './GatewaySection';
import TreeSection from './tree/TreeSection';
import {
  Settings,
  Plus,
} from 'lucide-react';
import {
  GET_WORKFLOW_INSTANCES,
  type GetWorkflowInstancesQuery,
} from '../graphql/workflow';
import { instanceStatusText } from './workflow/WorkflowNodeTreeConstants';
import InstantiateWorkflowDialog from './workflow/InstantiateWorkflowDialog';

interface SidebarProps {
  username: string;
  mobile?: boolean;
}

export default function Sidebar({ username, mobile }: SidebarProps) {
  const navigate = useNavigate();
  // 改为追踪「已折叠」集合，默认全部展开
  const [collapsedControllers, setCollapsedControllers] = useState<Set<string>>(new Set());
  const [showNewDialog, setShowNewDialog] = useState<{ controllerId?: string } | null>(null);
  const [showInstantiateDialog, setShowInstantiateDialog] = useState<{ controllerId: string; workspaceId?: string } | null>(null);
  const [showGatewayDialog, setShowGatewayDialog] = useState<string | null>(null);

  // 跟踪各控制器的工作区实例数
  const workflowInstanceCountsRef = useRef<Map<string, Set<string>>>(new Map());
  const [workflowInstanceCounts, setWorkflowInstanceCounts] = useState<Map<string, Set<string>>>(new Map());

  // 跟踪各控制器的网关数
  const gatewayCountsRef = useRef<Map<string, number>>(new Map());
  const [gatewayCounts, setGatewayCounts] = useState<Map<string, number>>(new Map());

  const { data: sessionsData } = useQuery<GetSessionsQuery>(GET_SESSIONS, {
    pollInterval: 15000,
  });
  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS, {
    pollInterval: 15000,
  });
  const { data: workspacesData } = useQuery<GetWorkspacesQuery>(GET_WORKSPACES, {
    pollInterval: 15000,
  });

  const [createSession] = useMutation<CreateSessionMutation>(CREATE_SESSION);

  const sessions = sessionsData?.sessions ?? [];
  const controllers = controllersData?.controllers ?? [];
  const allWorkspaces = workspacesData?.workspaces ?? [];

  const getWorkspaceNameForSession = (session: SessionData): string => {
    // 1. worktree 会话：从 worktreePath 推导
    if (session.worktreePath) {
      const parts = session.worktreePath.split('/').filter(Boolean);
      const wsName = parts[parts.length - 2];
      const ws = allWorkspaces.find(
        (w) => w.name === wsName && w.controllerId === session.controllerId,
      );
      return ws?.name || wsName || '';
    }
    // 2. 普通会话：按 cwd 匹配已配置工作区（最长前缀匹配）
    if (session.cwd && session.cwd.length > 0) {
      let bestMatch: string = '';
      let bestMatchLength = 0;
      for (const w of allWorkspaces) {
        if (w.controllerId !== session.controllerId || !w.isEnabled) continue;
        if (session.cwd!.startsWith(w.path)) {
          const rest = session.cwd!.slice(w.path.length);
          if (rest === '' || rest.startsWith('/')) {
            if (w.path.length > bestMatchLength) {
              bestMatchLength = w.path.length;
              bestMatch = w.name;
            }
          }
        }
      }
      return bestMatch || '';
    }
    return '';
  };

  const handleCreateSession = async (
    controllerId: string,
    acpServerType: string,
    workspaceId: string,
    enableWorktree?: boolean,
    worktreeBranchSuffix?: string,
    mcpServerIds?: string[],
    existingWorktreePath?: string,
  ) => {
    try {
      const { data } = await createSession({
        variables: {
          input: {
            controllerId,
            acpServerType,
            workspaceId,
            enableWorktree: existingWorktreePath ? false : (enableWorktree || false),
            worktreeBranchSuffix: worktreeBranchSuffix || null,
            mcpServerIds: mcpServerIds || null,
            existingWorktreePath: existingWorktreePath || null,
          },
        },
        refetchQueries: [{ query: GET_SESSIONS }],
      });
      if (data?.createSession?.session?.id) {
        navigate(`/sessions/${data.createSession.session.id}`);
        setShowNewDialog(null);
      }
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  const toggleController = (controllerId: string) => {
    setCollapsedControllers((prev) => {
      const next = new Set(prev);
      if (next.has(controllerId)) {
        next.delete(controllerId);
      } else {
        next.add(controllerId);
      }
      return next;
    });
  };

  // 稳定的回调函数，用于 WorkflowSidebarGroupInline 上报实例数
  const handleInstancesChange = useCallback((controllerId: string, workspaceId: string, count: number) => {
    const prev = workflowInstanceCountsRef.current;
    const controllerSet = prev.get(controllerId) || new Set<string>();

    if (count > 0) {
      controllerSet.add(workspaceId);
    } else {
      controllerSet.delete(workspaceId);
    }

    prev.set(controllerId, controllerSet);
    setWorkflowInstanceCounts(new Map(prev));
  }, []);

  // 稳定的回调函数，用于 GatewaySection 上报网关数
  const handleGatewaysChange = useCallback((controllerId: string, count: number) => {
    const prev = gatewayCountsRef.current;
    if (prev.get(controllerId) !== count) {
      prev.set(controllerId, count);
      setGatewayCounts(new Map(prev));
    }
  }, []);

  // 判断控制器是否有工作流实例
  const hasWorkflowInstances = (controllerId: string): boolean => {
    const controllerSet = workflowInstanceCounts.get(controllerId);
    return controllerSet !== undefined && controllerSet.size > 0;
  };

  // 判断控制器是否有网关
  const hasGateways = (controllerId: string): boolean => {
    const count = gatewayCounts.get(controllerId);
    return count !== undefined && count > 0;
  };

  return (
    <nav className={`flex flex-col bg-sidebar text-sidebar-foreground ${mobile ? 'h-full' : 'h-screen'}`} aria-label="Sidebar">
      <div className="flex-1 overflow-y-auto p-4">
        <ul className="space-y-1">
          {controllers.map((controller) => {
            // 默认展开，除非在 collapsedControllers 中
            const isExpanded = !collapsedControllers.has(controller.id);
            const isOffline = controller.status !== 'online';
            const controllerSessions = sessions.filter((s) => s.controllerId === controller.id);
            const controllerWorkspaces = allWorkspaces.filter(
              (w) => w.controllerId === controller.id && w.isEnabled,
            );

            return (
              <li key={controller.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent ${
                    isOffline ? 'opacity-50' : ''
                  }`}
                  onClick={() => toggleController(controller.id)}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${
                    controller.status === 'online' ? 'bg-success' : 'bg-muted-foreground'
                  }`} />
                  <span className="flex-1 truncate text-left font-medium">
                    {controller.name || controller.hostname}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/settings?controllerId=${controller.id}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        navigate(`/settings?controllerId=${controller.id}`);
                      }
                    }}
                    className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                    title="控制器配置"
                  >
                    <Settings className="size-3.5" />
                  </span>
                </button>

                {isExpanded && (
                  <div className="ml-2 mt-1 space-y-1 border-l border-sidebar-border pl-2">
                    {controller.status === 'online' && (
                      <TreeSection
                        title="统一网关"
                        actions={
                          <button
                            type="button"
                            className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                            title="新增网关"
                            onClick={() => setShowGatewayDialog(controller.id)}
                          >
                            <Plus className="size-3" />
                          </button>
                        }
                        emptyMessage="无网关暴露"
                        hasContent={hasGateways(controller.id)}
                      >
                        <GatewaySection
                          controllerId={controller.id}
                          inline
                          externalShowDialog={showGatewayDialog === controller.id}
                          onDialogClose={() => setShowGatewayDialog(null)}
                          onGatewaysChange={handleGatewaysChange}
                        />
                      </TreeSection>
                    )}

                    <TreeSection
                      title="工作流"
                      actions={
                        <button
                          type="button"
                          className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                          title="实例化工作流"
                          onClick={() => setShowInstantiateDialog({ controllerId: controller.id })}
                        >
                          <Plus className="size-3" />
                        </button>
                      }
                      emptyMessage="无工作流实例"
                      hasContent={hasWorkflowInstances(controller.id)}
                    >
                      {controllerWorkspaces.map((ws) => (
                        <WorkflowSidebarGroupInline
                          key={ws.id}
                          workspaceId={ws.id}
                          controllerId={controller.id}
                          workspaceName={ws.name}
                          onInstancesChange={handleInstancesChange}
                        />
                      ))}
                    </TreeSection>

                    <TreeSection
                      title="会话"
                      count={controllerSessions.length}
                      emptyMessage="无会话"
                      actions={
                        <button
                          type="button"
                          className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                          title="新建会话"
                          onClick={() => setShowNewDialog({ controllerId: controller.id })}
                        >
                          <Plus className="size-3" />
                        </button>
                      }
                    >
                      {controllerSessions.map((session) => {
                        const wsName = getWorkspaceNameForSession(session);
                        return (
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
                                <div className="truncate">{session.title || 'New Session'}</div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {wsName || <span className="text-muted-foreground/50">未知工作区</span>}
                                </div>
                              </div>
                            </NavLink>
                          </li>
                        );
                      })}
                    </TreeSection>

                    <TreeSection
                      title="工作区"
                      count={controllerWorkspaces.length}
                      emptyMessage="无工作区"
                    >
                      {controllerWorkspaces.map((ws) => (
                        <WorktreeSidebarGroup
                          key={ws.id}
                          workspaceId={ws.id}
                          controllerId={controller.id}
                          workspaceName={ws.name}
                          controllers={controllers}
                          fallbackSessions={controllerSessions.filter(
                            (s) => s.worktreePath && getWorkspaceNameForSession(s) === ws.name,
                          )}
                          onCreate={handleCreateSession}
                        />
                      ))}
                    </TreeSection>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {showNewDialog && (
        <NewSessionDialog
          controllers={controllers}
          onClose={() => setShowNewDialog(null)}
          onCreate={handleCreateSession}
          existingControllerId={showNewDialog.controllerId}
        />
      )}

      {showInstantiateDialog && (
        <InstantiateWorkflowDialog
          open={true}
          onOpenChange={() => setShowInstantiateDialog(null)}
          controllerId={showInstantiateDialog.controllerId}
          workspaceId={showInstantiateDialog.workspaceId}
        />
      )}

      {mobile && (
        <NavLink
          to="/settings"
          className="flex items-center gap-2 border-t border-sidebar-border px-4 py-3 text-sm text-sidebar-foreground hover:text-sidebar-foreground"
        >
          <Settings className="size-4" />
          <span>设置</span>
        </NavLink>
      )}

      <div className="sticky bottom-0 border-t border-sidebar-border p-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{username}</span>
          <div className="flex items-center gap-1">
            <TodoListPanel />
            <ThemeToggle />
            <NavLink
              to="/settings"
              aria-label="Settings"
              className={({ isActive }) =>
                `rounded p-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  isActive ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-muted-foreground hover:text-sidebar-foreground'
                }`
              }
            >
              <Settings className="size-4" />
            </NavLink>
          </div>
        </div>
      </div>
    </nav>
  );
}

interface WorkflowSidebarGroupInlineProps {
  workspaceId: string;
  controllerId: string;
  workspaceName: string;
  onInstancesChange: (controllerId: string, workspaceId: string, count: number) => void;
}

function WorkflowSidebarGroupInline({
  workspaceId,
  controllerId,
  workspaceName,
  onInstancesChange,
}: WorkflowSidebarGroupInlineProps) {
  const { data } = useQuery<GetWorkflowInstancesQuery>(GET_WORKFLOW_INSTANCES, {
    variables: { workspaceId },
    pollInterval: 15000,
  });

  const instances = data?.workflowInstances ?? [];

  // 上报实例数变化
  useEffect(() => {
    onInstancesChange(controllerId, workspaceId, instances.length);
    return () => {
      onInstancesChange(controllerId, workspaceId, 0);
    };
  }, [controllerId, workspaceId, instances.length, onInstancesChange]);

  return (
    <>
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
                {workspaceName} · {instanceStatusText(instance)}
              </div>
            </div>
          </NavLink>
        </li>
      ))}
    </>
  );
}