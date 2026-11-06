import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client/react';
import { toast } from 'sonner';
import { CREATE_SESSION } from '../graphql/mutations';
import { logger } from '../lib/logger';
import type {
  CloudHostCapabilitiesData,
  CreateSessionMutation,
  GetCloudHostCapabilitiesQuery,
  SessionData,
} from '../graphql/types';
import type { WorkflowInstanceSummaryData } from '../graphql/workflow';
import NewSessionDialog from './session/NewSessionDialog';
import NewCloudHostDialog from './cloud-host/NewCloudHostDialog';
import GithubProjectSetupDialog from './cloud-host/GithubProjectSetupDialog';
import {
  cloudHostStatusDotClass,
  cloudHostStatusText,
  isTerminalCloudHost,
} from './cloud-host/cloud-host-status';
import { getStatusDotColor } from './session/status-colors';
import WorktreeSidebarGroup from './worktree/WorktreeSidebarGroup';
import { TodoListPanel } from './TodoListPanel';
import ThemeToggle from './ThemeToggle';
import TreeSection from './tree/TreeSection';
import ReviewSection from './sidebar/ReviewSection';
import GatewayItem from './GatewayItem';
import GatewayDialog from './GatewayDialog';
import WorkflowInstanceCard from './workflow/WorkflowInstanceCard';
import {
  Settings,
  Plus,
  ChevronDown,
  ChevronRight,
  Archive,
  Cloud,
  CreditCard,
  GitBranch,
} from 'lucide-react';
import InstantiateWorkflowDialog from './workflow/InstantiateWorkflowDialog';
import { HOME_OVERVIEW } from '../graphql/home';
import { CLOUD_HOST_CAPABILITIES } from '../graphql/queries';
import { useHomeOverview } from '../stores/homeOverview';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import {
  persistSidebarSections,
  readSidebarSections,
  sortByUpdatedAtDesc,
  type SidebarSectionKey,
  type SidebarSections,
} from '@/lib/sidebar-prefs';

interface SidebarProps {
  /** 当前用户展示名（登录响应 User.name，迁移后=原用户名） */
  name: string;
  mobile?: boolean;
}

/** 主机选择浮层：聚合分区的新建入口先选主机，再打开对应对话框 */
function ControllerPicker({
  controllers,
  onPick,
}: {
  controllers: Array<{ id: string; name?: string | null; hostname?: string | null }>;
  onPick: (controllerId: string) => void;
}) {
  return (
    <ul
      role="menu"
      className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border bg-popover p-1 text-xs text-popover-foreground shadow-md"
    >
      {controllers.map((controller) => (
        <li key={controller.id}>
          <button
            type="button"
            role="menuitem"
            className="w-full truncate rounded px-2 py-1 text-left hover:bg-accent"
            onClick={() => onPick(controller.id)}
          >
            {controller.name || controller.hostname}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 全宽可折叠分区（类 VSCode）：标题行占满侧边栏，点击切换，右侧 actions */
function SidebarSection({
  sectionKey,
  title,
  count,
  actions,
  expanded,
  onToggle,
  children,
}: {
  sectionKey: SidebarSectionKey;
  title: string;
  count?: number;
  actions?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-sidebar-border/60 py-0.5" data-testid={`sidebar-section-${sectionKey}`}>
      <div className="flex w-full items-center gap-1 rounded px-2 py-1.5 transition-colors hover:bg-sidebar-accent/60">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={title}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold tracking-wide text-muted-foreground hover:text-foreground"
          onClick={onToggle}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-normal">{count}</span>
          )}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {expanded && <div data-testid={`sidebar-section-content-${sectionKey}`} className="mt-0.5">{children}</div>}
    </section>
  );
}

export default function Sidebar({ name, mobile }: SidebarProps) {
  const navigate = useNavigate();
  const [sections, setSections] = useState<SidebarSections>(readSidebarSections);
  // 主机分区内每个主机默认展开（追踪「已折叠」集合）
  const [collapsedControllers, setCollapsedControllers] = useState<Set<string>>(new Set());
  const [showNewDialog, setShowNewDialog] = useState<{ controllerId?: string } | null>(null);
  const [showNewCloudHost, setShowNewCloudHost] = useState(false);
  const [showInstantiateDialog, setShowInstantiateDialog] = useState<{ controllerId: string; workspaceId?: string } | null>(null);
  const [showGatewayDialog, setShowGatewayDialog] = useState<string | null>(null);
  const [showGithubSetup, setShowGithubSetup] = useState<{ controllerId: string } | null>(null);
  // 聚合分区的新建入口需要先选择目标主机（工作流实例化 / 网关新增）
  const [picker, setPicker] = useState<'instantiate' | 'gateway' | null>(null);

  // 首页 + 侧边栏统一数据源（由 MainLayout 的 HOME_OVERVIEW 一次加载）
  const { data, refetch } = useHomeOverview();

  // 云电脑开关与支持的 Harness（HARNESS_ENABLED=false 时隐藏入口）
  const { data: capabilitiesData } = useQuery<GetCloudHostCapabilitiesQuery>(CLOUD_HOST_CAPABILITIES);
  const capabilities: CloudHostCapabilitiesData | undefined = capabilitiesData?.cloudHostCapabilities;

  const [createSession] = useMutation<CreateSessionMutation>(CREATE_SESSION);

  const sessions = data?.sessions ?? [];
  const archivedSessions = data?.archivedSessions ?? [];
  const controllers = data?.controllers ?? [];
  const allWorkspaces = data?.workspaces ?? [];
  const workflowInstances = data?.workflowInstances ?? [];
  const archivedWorkflowInstances = data?.archivedWorkflowInstances ?? [];

  const githubSetupController = showGithubSetup
    ? controllers.find((controller) => controller.id === showGithubSetup.controllerId)
    : undefined;
  const githubSetupHost = githubSetupController?.cloudHost ?? null;

  const toggleSection = (key: SidebarSectionKey) => {
    setSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      persistSidebarSections(next);
      return next;
    });
  };

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
    modeId?: string,
    modelId?: string,
    customMcpServerIds?: string[],
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
            // 显式空数组 = 不注入；undefined 走控制器默认
            mcpServerIds: mcpServerIds === undefined ? null : mcpServerIds,
            existingWorktreePath: existingWorktreePath || null,
            modeId: modeId || null,
            modelId: modelId || null,
            // 第 10 参：自定义 MCP；undefined/[] 不注入（保持旧报文形状不含该键）
            ...(customMcpServerIds && customMcpServerIds.length > 0
              ? { customMcpServerIds }
              : {}),
          },
        },
        refetchQueries: [{ query: HOME_OVERVIEW }],
      });
      if (result?.createSession?.session?.id) {
        navigate(`/sessions/${result.createSession.session.id}`);
        setShowNewDialog(null);
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to create session');
      // C-19：创建失败不能静默（弹窗已关闭，至少给出可感知反馈）
      toast.error(error instanceof Error ? error.message : '创建会话失败，请重试');
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

  const onlineControllers = controllers.filter((controller) => controller.status === 'online');
  // 网关聚合与既有口径一致：仅在线主机的网关配置行上屏（离线主机不渲染其网关条目）
  const gatewayRows = onlineControllers.flatMap((controller) =>
    (controller.gateways?.gateways ?? []).map((gateway) => ({
      gateway,
      controllerId: controller.id,
    })),
  );
  const sortedSessions = sortByUpdatedAtDesc(sessions.map((session) => ({ ...session, updatedAt: session.updatedAt ?? '' })));
  const sortedArchivedSessions = sortByUpdatedAtDesc(archivedSessions.map((session) => ({ ...session, updatedAt: session.updatedAt ?? '' })));
  const sortedWorkflows = sortByUpdatedAtDesc(workflowInstances);
  const sortedArchivedWorkflows = sortByUpdatedAtDesc(archivedWorkflowInstances);
  const gatewayCount = gatewayRows.length;

  return (
    <nav className={`flex flex-col bg-sidebar text-sidebar-foreground ${mobile ? 'h-full' : 'h-screen'}`} aria-label="Sidebar">
      <div className="flex-1 overflow-y-auto p-2">
        <WorkspaceSwitcher />

        {/* 分区 1：主机（保留现有视图内容：主机 → 工作区 → 会话） */}
        <SidebarSection
          sectionKey="hosts"
          title="主机"
          count={controllers.length}
          expanded={sections.hosts}
          onToggle={() => toggleSection('hosts')}
          actions={capabilities?.enabled && (
            <button
              type="button"
              aria-label="新建云电脑"
              title="新建云电脑"
              onClick={() => setShowNewCloudHost(true)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="relative inline-flex">
                <Cloud className="size-4" />
                <Plus className="absolute -right-1.5 -top-1.5 size-2.5" />
              </span>
            </button>
          )}
        >
          <ul className="space-y-0.5">
            {controllers.map((controller) => {
              const isExpanded = !collapsedControllers.has(controller.id);
              const isOffline = controller.status !== 'online';
              const isCloud = controller.type === 'cloud';
              const cloudHost = controller.cloudHost ?? null;
              const cloudTerminal = isCloud && isTerminalCloudHost(cloudHost);
              const cloudHostRunning = isCloud && cloudHost?.status === 'RUNNING' && !cloudHost.deletedAt;
              const dimmed = isCloud ? cloudTerminal : isOffline;
              const controllerSessions = sessions.filter((s) => s.controllerId === controller.id);
              const controllerWorkspaces = allWorkspaces.filter(
                (w) => w.controllerId === controller.id && w.isEnabled,
              );

              return (
                <li key={controller.id}>
                  <div
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent ${
                      dimmed ? 'opacity-50' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => toggleController(controller.id)}
                      aria-expanded={isExpanded}
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
                          <>
                            <span
                              className="truncate text-xs text-muted-foreground"
                              title={cloudHost.failureReason || undefined}
                              data-testid="cloud-host-status"
                            >
                              {cloudHostStatusText(cloudHost)}
                              {cloudHost.status === 'FAILED' && cloudHost.failureReason
                                ? ` · ${cloudHost.failureReason}`
                                : ''}
                            </span>
                            {cloudHostRunning
                              && cloudHost.hasDefaultWorkspace === false
                              && controllerWorkspaces.length === 0 && (
                              <span
                                className="truncate text-xs text-muted-foreground"
                                data-testid="cloud-host-no-workspace-hint"
                              >
                                未创建默认工作区，请先创建或绑定工作区
                              </span>
                            )}
                            {cloudHostRunning
                              && cloudHost.hasDefaultWorkspace !== false
                              && cloudHost.harnessTypes.length === 1
                              && !cloudHost.defaultSessionId && (
                                <span
                                  className="truncate text-xs text-destructive"
                                  data-testid="cloud-host-default-session-hint"
                                >
                                  默认会话创建失败，可手动创建会话
                                </span>
                              )}
                          </>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      title={isCloud && !cloudHostRunning ? '云电脑未运行，无法创建会话' : '新建会话'}
                      aria-label="新建会话"
                      disabled={isCloud && !cloudHostRunning}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowNewDialog({ controllerId: controller.id });
                      }}
                      className={`rounded p-0.5 transition-colors ${
                        isCloud && !cloudHostRunning
                          ? 'cursor-not-allowed text-muted-foreground opacity-50'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Plus className="size-3.5" />
                    </button>
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
                      aria-label={`${controller.name || controller.hostname} 控制器配置`}
                    >
                      <Settings className="size-3.5" />
                    </span>
                  </div>

                  {isExpanded && (
                    <div className="mt-0.5 space-y-0.5">
                      <TreeSection
                        title="工作区"
                        count={controllerWorkspaces.length}
                        hasContent={controllerWorkspaces.length > 0}
                        level={1}
                        actions={
                          cloudHostRunning ? (
                            <>
                              <button
                                type="button"
                                aria-label="Github 项目设置"
                                title="Github 项目设置"
                                onClick={() => setShowGithubSetup({ controllerId: controller.id })}
                                className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                              >
                                <GitBranch className="size-3" />
                              </button>
                              {cloudHost?.hasDefaultWorkspace === false && (
                                <button
                                  type="button"
                                  aria-label="新建工作区"
                                  title="新建工作区"
                                  onClick={() => navigate(`/settings?controllerId=${controller.id}`)}
                                  className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                                >
                                  <Plus className="size-3" />
                                </button>
                              )}
                            </>
                          ) : undefined
                        }
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
        </SidebarSection>

        {/* 分区 2：工作流（跨环境聚合，含已归档分组） */}
        <SidebarSection
          sectionKey="workflows"
          title="工作流"
          count={sortedWorkflows.length + sortedArchivedWorkflows.length}
          expanded={sections.workflows}
          onToggle={() => toggleSection('workflows')}
          actions={controllers.length > 0 && (
            <div className="relative">
              <button
                type="button"
                className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="实例化工作流"
                aria-label="实例化工作流"
                aria-expanded={picker === 'instantiate'}
                onClick={() => setPicker((prev) => (prev === 'instantiate' ? null : 'instantiate'))}
              >
                <Plus className="size-3.5" />
              </button>
              {picker === 'instantiate' && (
                <ControllerPicker
                  controllers={controllers}
                  onPick={(controllerId) => {
                    setPicker(null);
                    setShowInstantiateDialog({ controllerId });
                  }}
                />
              )}
            </div>
          )}
        >
          <ul className="space-y-0.5" data-testid="sidebar-workflow-list">
            {sortedWorkflows.map((instance) => (
              <WorkflowInstanceCard key={instance.id} instance={instance} />
            ))}
            {sortedArchivedWorkflows.length > 0 && (
              <ArchivedWorkflowGroup instances={sortedArchivedWorkflows} />
            )}
          </ul>
        </SidebarSection>

        {/* 分区 3：会话（跨环境聚合） */}
        <SidebarSection
          sectionKey="sessions"
          title="会话"
          count={sessions.length}
          expanded={sections.sessions}
          onToggle={() => toggleSection('sessions')}
          actions={
            <button
              type="button"
              className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
              title="新建会话"
              aria-label="新建会话"
              onClick={() => setShowNewDialog({})}
            >
              <Plus className="size-3.5" />
            </button>
          }
        >
          <ul className="space-y-0.5" data-testid="sidebar-session-list">
            {sortedSessions.map((session) => {
              const controller = controllers.find((item) => item.id === session.controllerId);
              return (
                <SessionListEntry
                  key={session.id}
                  session={session}
                  title={controller ? `${session.title || 'New Session'} · ${controller.name || controller.hostname}` : undefined}
                  resolveWorkspaceName={getWorkspaceNameForSession}
                />
              );
            })}
            {sortedArchivedSessions.length > 0 && (
              <ArchivedSessionGroup
                sessions={sortedArchivedSessions}
                controllers={controllers}
                resolveWorkspaceName={getWorkspaceNameForSession}
              />
            )}
          </ul>
        </SidebarSection>

        {/* 分区 4：网关（聚合全部环境） */}
        <SidebarSection
          sectionKey="gateways"
          title="网关"
          count={gatewayCount}
          expanded={sections.gateways}
          onToggle={() => toggleSection('gateways')}
          actions={onlineControllers.length > 0 && (
            <div className="relative">
              <button
                type="button"
                className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="新增网关"
                aria-label="新增网关"
                aria-expanded={picker === 'gateway'}
                onClick={() => setPicker((prev) => (prev === 'gateway' ? null : 'gateway'))}
              >
                <Plus className="size-3.5" />
              </button>
              {picker === 'gateway' && (
                <ControllerPicker
                  controllers={onlineControllers}
                  onPick={(controllerId) => {
                    setPicker(null);
                    setShowGatewayDialog(controllerId);
                  }}
                />
              )}
            </div>
          )}
        >
          <ul className="space-y-0.5" data-testid="sidebar-gateway-list">
            {gatewayRows.map(({ gateway, controllerId }) => (
              <GatewayItem key={gateway.id} gateway={gateway} controllerId={controllerId} />
            ))}
          </ul>
        </SidebarSection>

        {/* Review 分区（#461）：待 Review 默认展开、已 Review 默认折叠；空分区不渲染 */}
        <ReviewSection sessionReviews={data?.sessionReviews ?? []} />
      </div>

      {showNewCloudHost && capabilities && (
        <NewCloudHostDialog
          open={showNewCloudHost}
          capabilities={capabilities}
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

      {showGatewayDialog && (
        <GatewayDialog
          controllerId={showGatewayDialog}
          onClose={() => setShowGatewayDialog(null)}
        />
      )}

      {showGithubSetup && githubSetupController && githubSetupHost && (
        <GithubProjectSetupDialog
          open={true}
          controllerId={githubSetupController.id}
          cloudHost={githubSetupHost}
          onClose={() => setShowGithubSetup(null)}
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
          <span className="truncate text-sm font-medium">{name}</span>
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

/** 已归档实例：自折叠分组（沿用聚合列表结构） */
function ArchivedWorkflowGroup({ instances }: { instances: WorkflowInstanceSummaryData[] }) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        className="flex items-center gap-1 rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setArchivedOpen((prev) => !prev)}
        aria-expanded={archivedOpen}
      >
        {archivedOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Archive className="size-3" />
        已归档（{instances.length}）
      </button>
      {archivedOpen && (
        <ul className="ml-4 space-y-1">
          {instances.map((instance) => (
            <WorkflowInstanceCard key={instance.id} instance={instance} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** 会话条目（活跃列表与已归档分组共用同一结构，点击直达会话页） */
function SessionListEntry({
  session,
  title,
  resolveWorkspaceName,
}: {
  session: SessionData;
  title: string | undefined;
  resolveWorkspaceName: (session: SessionData) => string;
}) {
  const wsName = resolveWorkspaceName(session);
  return (
    <li>
      <NavLink
        to={`/sessions/${session.id}`}
        title={title}
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
}

/** 已归档会话：自折叠分组（复刻 ArchivedWorkflowGroup 交互，默认折叠，条目可打开） */
function ArchivedSessionGroup({
  sessions,
  controllers,
  resolveWorkspaceName,
}: {
  sessions: SessionData[];
  controllers: Array<{ id: string; name: string; hostname: string }>;
  resolveWorkspaceName: (session: SessionData) => string;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        className="flex items-center gap-1 rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setArchivedOpen((prev) => !prev)}
        aria-expanded={archivedOpen}
      >
        {archivedOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Archive className="size-3" />
        已归档（{sessions.length}）
      </button>
      {archivedOpen && (
        <ul className="ml-4 space-y-1" data-testid="sidebar-archived-session-list">
          {sessions.map((session) => {
            const controller = controllers.find((item) => item.id === session.controllerId);
            return (
              <SessionListEntry
                key={session.id}
                session={session}
                title={controller ? `${session.title || 'New Session'} · ${controller.name || controller.hostname}` : undefined}
                resolveWorkspaceName={resolveWorkspaceName}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
}
