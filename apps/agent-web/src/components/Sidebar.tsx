import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client/react';
import { CREATE_SESSION } from '../graphql/mutations';
import type {
  CloudHostCapabilitiesData,
  CreateSessionMutation,
  GetCloudHostCapabilitiesQuery,
  SessionData,
} from '../graphql/types';
import type { WorkflowInstanceSummaryData } from '../graphql/workflow';
import NewSessionDialog from './session/NewSessionDialog';
import NewCloudHostDialog from './cloud-host/NewCloudHostDialog';
import {
  cloudHostStatusDotClass,
  cloudHostStatusLabel,
  isActiveCloudHost,
  isTerminalCloudHost,
} from './cloud-host/cloud-host-status';
import { getStatusDotColor } from './session/status-colors';
import WorktreeSidebarGroup from './worktree/WorktreeSidebarGroup';
import { TodoListPanel } from './TodoListPanel';
import ThemeToggle from './ThemeToggle';
import GatewaySection from './GatewaySection';
import TreeSection from './tree/TreeSection';
import {
  Settings,
  Plus,
  ChevronDown,
  ChevronRight,
  Archive,
  Cloud,
  CreditCard,
} from 'lucide-react';
import { instanceStatusText } from './workflow/WorkflowNodeTreeConstants';
import InstantiateWorkflowDialog from './workflow/InstantiateWorkflowDialog';
import { HOME_OVERVIEW } from '../graphql/home';
import { CLOUD_HOST_CAPABILITIES } from '../graphql/queries';
import { useHomeOverview } from '../stores/homeOverview';

interface SidebarProps {
  username: string;
  mobile?: boolean;
}

export default function Sidebar({ username, mobile }: SidebarProps) {
  const navigate = useNavigate();
  // 改为追踪「已折叠」集合，默认全部展开
  const [collapsedControllers, setCollapsedControllers] = useState<Set<string>>(new Set());
  const [showNewDialog, setShowNewDialog] = useState<{ controllerId?: string } | null>(null);
  const [showNewCloudHost, setShowNewCloudHost] = useState(false);
  const [showInstantiateDialog, setShowInstantiateDialog] = useState<{ controllerId: string; workspaceId?: string } | null>(null);
  const [showGatewayDialog, setShowGatewayDialog] = useState<string | null>(null);

  // 首页 + 侧边栏统一数据源（由 MainLayout 的 HOME_OVERVIEW 一次加载）
  const { data, refetch } = useHomeOverview();

  // 云电脑开关与支持的 Harness（HARNESS_ENABLED=false 时隐藏入口）
  const { data: capabilitiesData } = useQuery<GetCloudHostCapabilitiesQuery>(CLOUD_HOST_CAPABILITIES);
  const capabilities: CloudHostCapabilitiesData | undefined = capabilitiesData?.cloudHostCapabilities;

  const [createSession] = useMutation<CreateSessionMutation>(CREATE_SESSION);

  const sessions = data?.sessions ?? [];
  const controllers = data?.controllers ?? [];
  const allWorkspaces = data?.workspaces ?? [];
  const workflowInstances = data?.workflowInstances ?? [];
  const archivedWorkflowInstances = data?.archivedWorkflowInstances ?? [];

  const hasActiveCloudHost = controllers.some((controller) => isActiveCloudHost(controller.cloudHost));

  const handleCloudHostCreated = (cloudHost: { id: string; controllerId?: string }) => {
    setShowNewCloudHost(false);
    refetch();
    const controllerId =
      cloudHost.controllerId ||
      controllers.find((controller) => controller.cloudHost?.id === cloudHost.id)?.id;
    if (controllerId) {
      navigate(`/settings?controllerId=${controllerId}`);
    } else {
      navigate('/settings');
    }
  };

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
      const { data: result } = await createSession({
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
        refetchQueries: [{ query: HOME_OVERVIEW }],
      });
      if (result?.createSession?.session?.id) {
        navigate(`/sessions/${result.createSession.session.id}`);
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

  return (
    <nav className={`flex flex-col bg-sidebar text-sidebar-foreground ${mobile ? 'h-full' : 'h-screen'}`} aria-label="Sidebar">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <span className="text-xs font-medium text-muted-foreground">主机</span>
          {capabilities?.enabled && (
            <button
              type="button"
              aria-label="新建云电脑"
              title={hasActiveCloudHost ? '每用户同时最多 1 个云电脑实例' : '新建云电脑'}
              disabled={hasActiveCloudHost}
              onClick={() => setShowNewCloudHost(true)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="relative inline-flex">
                <Cloud className="size-4" />
                <Plus className="absolute -right-1.5 -top-1.5 size-2.5" />
              </span>
            </button>
          )}
        </div>
        <ul className="space-y-1">
          {controllers.map((controller) => {
            // 默认展开，除非在 collapsedControllers 中
            const isExpanded = !collapsedControllers.has(controller.id);
            const isOffline = controller.status !== 'online';
            const isCloud = controller.type === 'cloud';
            const cloudHost = controller.cloudHost ?? null;
            const cloudTerminal = isCloud && isTerminalCloudHost(cloudHost);
            const cloudHostRunning = isCloud && cloudHost?.status === 'RUNNING' && !cloudHost.deletedAt;
            // 已销毁/失败的云电脑置灰；普通主机沿用离线置灰规则
            const dimmed = isCloud ? cloudTerminal : isOffline;
            const controllerSessions = sessions.filter((s) => s.controllerId === controller.id);
            const controllerWorkspaces = allWorkspaces.filter(
              (w) => w.controllerId === controller.id && w.isEnabled,
            );
            // 工作流集中列表：按控制器平铺全部实例（不再按工作区拆分组）
            const controllerInstances = workflowInstances.filter((i) => i.controllerId === controller.id);
            const controllerArchivedInstances = archivedWorkflowInstances.filter(
              (i) => i.controllerId === controller.id,
            );
            const gateways = controller.gateways?.gateways ?? [];
            const hasWorkflowInstances =
              controllerInstances.length + controllerArchivedInstances.length > 0;

            return (
              <li key={controller.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent ${
                    dimmed ? 'opacity-50' : ''
                  }`}
                  onClick={() => toggleController(controller.id)}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${
                    isCloud && cloudHost
                      ? cloudHostStatusDotClass(cloudHost.status)
                      : controller.status === 'online' ? 'bg-success' : 'bg-muted-foreground'
                  }`} />
                  <span className="flex min-w-0 flex-1 flex-col text-left">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {isCloud && <Cloud className="size-3.5 shrink-0" data-testid="cloud-host-icon" />}
                      <span className="truncate font-medium">
                        {controller.name || controller.hostname}
                      </span>
                    </span>
                    {isCloud && cloudHost && (
                      <span
                        className="truncate text-xs text-muted-foreground"
                        title={cloudHost.failureReason || undefined}
                        data-testid="cloud-host-status"
                      >
                        {cloudHostStatusLabel(cloudHost.status)}
                        {cloudHost.status === 'FAILED' && cloudHost.failureReason
                          ? ` · ${cloudHost.failureReason}`
                          : ''}
                      </span>
                    )}
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
                  <div className="mt-1 space-y-1">
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
                        hasContent={gateways.length > 0}
                      >
                        <GatewaySection
                          controllerId={controller.id}
                          gateways={gateways}
                          inline
                          externalShowDialog={showGatewayDialog === controller.id}
                          onDialogClose={() => setShowGatewayDialog(null)}
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
                      hasContent={hasWorkflowInstances}
                    >
                      <ControllerWorkflows
                        instances={controllerInstances}
                        archivedInstances={controllerArchivedInstances}
                      />
                    </TreeSection>

                    <TreeSection
                      title="会话"
                      count={controllerSessions.length}
                      emptyMessage="无会话"
                      actions={
                        isCloud && !cloudHostRunning ? (
                          <button
                            type="button"
                            title="云电脑未运行，无法创建会话"
                            disabled
                            className="cursor-not-allowed rounded p-0.5 text-muted-foreground opacity-50"
                            aria-label="新建会话"
                          >
                            <Plus className="size-3" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                            title="新建会话"
                            onClick={() => setShowNewDialog({ controllerId: controller.id })}
                          >
                            <Plus className="size-3" />
                          </button>
                        )
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
                          worktrees={ws.worktrees ?? []}
                          fallbackSessions={controllerSessions.filter(
                            (s) => {
                              // worktree 会话：匹配工作区名
                              if (s.worktreePath && getWorkspaceNameForSession(s) === ws.name) {
                                return true;
                              }
                              // 落在工作区根目录的会话：cwd 等于工作区路径
                              if (s.cwd && s.cwd === ws.path) {
                                return true;
                              }
                              return false;
                            },
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

      {showNewCloudHost && capabilities && (
        <NewCloudHostDialog
          open={showNewCloudHost}
          capabilities={capabilities}
          hasActiveCloudHost={hasActiveCloudHost}
          onClose={() => setShowNewCloudHost(false)}
          onCreated={handleCloudHostCreated}
        />
      )}

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
        <>
          <NavLink
            to="/billing"
            className="flex items-center gap-2 border-t border-sidebar-border px-4 py-3 text-sm text-sidebar-foreground hover:text-sidebar-foreground"
          >
            <CreditCard className="size-4" />
            <span>我的费用</span>
          </NavLink>
          <NavLink
            to="/settings"
            className="flex items-center gap-2 border-t border-sidebar-border px-4 py-3 text-sm text-sidebar-foreground hover:text-sidebar-foreground"
          >
            <Settings className="size-4" />
            <span>设置</span>
          </NavLink>
        </>
      )}

      <div className="sticky bottom-0 border-t border-sidebar-border p-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{username}</span>
          <div className="flex items-center gap-1">
            <TodoListPanel />
            <ThemeToggle />
            <button
              type="button"
              className="rounded p-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring text-muted-foreground hover:text-sidebar-foreground"
              title="新建会话"
              onClick={() => setShowNewDialog({})}
              aria-label="新建会话"
            >
              <Plus className="size-4" />
            </button>
            <NavLink
              to="/billing"
              aria-label="我的费用"
              className={({ isActive }) =>
                `rounded p-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  isActive ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-muted-foreground hover:text-sidebar-foreground'
                }`
              }
            >
              <CreditCard className="size-4" />
            </NavLink>
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

/** 单个工作流条目：展示名称 + 所属工作区/控制器（未知归属置灰）· 状态 */
function WorkflowInstanceItem({ instance }: { instance: WorkflowInstanceSummaryData }) {
  const workspaceName = instance.workspace?.name;
  const controllerName = instance.controller?.name;
  return (
    <li>
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
            {workspaceName ?? <span className="text-muted-foreground/50">未知工作区</span>}
            {' · '}
            {controllerName ?? <span className="text-muted-foreground/50">未知控制器</span>}
            {' · '}
            {instanceStatusText(instance)}
          </div>
        </div>
      </NavLink>
    </li>
  );
}

/** 控制器工作流集中列表：活跃实例平铺 + 归档实例折叠 */
function ControllerWorkflows({
  instances,
  archivedInstances,
}: {
  instances: WorkflowInstanceSummaryData[];
  archivedInstances: WorkflowInstanceSummaryData[];
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);

  return (
    <>
      {instances.map((instance) => (
        <WorkflowInstanceItem key={instance.id} instance={instance} />
      ))}
      {archivedInstances.length > 0 && (
        <li>
          <button
            type="button"
            className="flex items-center gap-1 rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setArchivedOpen((prev) => !prev)}
            aria-expanded={archivedOpen}
          >
            {archivedOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <Archive className="size-3" />
            已归档（{archivedInstances.length}）
          </button>
          {archivedOpen && (
            <ul className="ml-4 space-y-1">
              {archivedInstances.map((instance) => (
                <WorkflowInstanceItem key={instance.id} instance={instance} />
              ))}
            </ul>
          )}
        </li>
      )}
    </>
  );
}
