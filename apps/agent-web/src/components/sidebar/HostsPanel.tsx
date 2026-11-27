import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cloud, GitBranch, Plus, Settings } from 'lucide-react';
import type {
  HomeOverviewControllerData,
  HomeOverviewWorkspaceData,
  SessionData,
} from '@/graphql/types';
import {
  cloudHostStatusDotClass,
  cloudHostStatusText,
  isTerminalCloudHost,
} from '../cloud-host/cloud-host-status';
import TreeSection from '../tree/TreeSection';
import WorktreeSidebarGroup from '../worktree/WorktreeSidebarGroup';
import GatewayItem from '../GatewayItem';

export interface HostsPanelProps {
  controllers: HomeOverviewControllerData[];
  allWorkspaces: HomeOverviewWorkspaceData[];
  sessions: SessionData[];
  resolveWorkspaceName: (session: SessionData) => string;
  onCreateSession: (
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
  ) => Promise<void>;
  onOpenNewSession: (controllerId: string) => void;
  onOpenGithubSetup: (controllerId: string) => void;
  onOpenNewGateway: (controllerId: string) => void;
}

/** 主机选择浮层：新增网关时先选择在线主机 */
function OnlineControllerPicker({
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

/** 主机与网关领域专视图：控制器/云电脑 → 工作区 → Worktree 树 + 在线主机端口转发网关 */
export default function HostsPanel({
  controllers,
  allWorkspaces,
  sessions,
  resolveWorkspaceName,
  onCreateSession,
  onOpenNewSession,
  onOpenGithubSetup,
  onOpenNewGateway,
}: HostsPanelProps) {
  const navigate = useNavigate();
  const [collapsedControllers, setCollapsedControllers] = useState<Set<string>>(new Set());
  const [gatewayPickerOpen, setGatewayPickerOpen] = useState(false);

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
  const gatewayRows = onlineControllers.flatMap((controller) =>
    (controller.gateways?.gateways ?? []).map((gateway) => ({
      gateway,
      controllerId: controller.id,
    })),
  );

  return (
    <div
      data-testid="context-panel-domain-hosts"
      className="min-h-0 flex-1 overflow-y-auto p-2"
    >
      {controllers.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">暂无主机或云电脑</p>
      ) : (
        <ul className="space-y-1" data-testid="sidebar-host-list">
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
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent ${
                    dimmed ? 'opacity-50' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => toggleController(controller.id)}
                    aria-expanded={isExpanded}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        isCloud && cloudHost
                          ? cloudHostStatusDotClass(cloudHost.status)
                          : controller.status === 'online'
                            ? 'bg-success'
                            : 'bg-muted-foreground'
                      }`}
                    />
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
                          {cloudHostRunning &&
                            cloudHost.hasDefaultWorkspace === false &&
                            controllerWorkspaces.length === 0 && (
                              <span
                                className="truncate text-xs text-muted-foreground"
                                data-testid="cloud-host-no-workspace-hint"
                              >
                                未创建默认工作区，请先创建或绑定工作区
                              </span>
                            )}
                          {cloudHostRunning &&
                            cloudHost.hasDefaultWorkspace !== false &&
                            cloudHost.harnessTypes.length === 1 &&
                            !cloudHost.defaultSessionId && (
                              <span
                                className="truncate text-xs text-destructive-text"
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
                      onOpenNewSession(controller.id);
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
                              onClick={() => onOpenGithubSetup(controller.id)}
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
                          fallbackSessions={controllerSessions.filter((s) => {
                            if (s.worktreePath && resolveWorkspaceName(s) === ws.name) {
                              return true;
                            }
                            if (s.cwd && s.cwd === ws.path) {
                              return true;
                            }
                            return false;
                          })}
                          onCreate={onCreateSession}
                        />
                      ))}
                    </TreeSection>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* 下半区：端口转发网关（仅展示在线主机的网关） */}
      <div className="mt-4 border-t border-sidebar-border pt-3" data-testid="hosts-gateway-subsection">
        <div className="mb-1.5 flex items-center justify-between px-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground">网关</span>
            <span className="rounded-full bg-card px-1.5 py-0.5 text-xs font-medium tabular-nums text-foreground ring-1 ring-sidebar-border">
              {gatewayRows.length}
            </span>
          </div>
          {onlineControllers.length > 0 && (
            <div className="relative">
              <button
                type="button"
                className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="新增网关"
                aria-label="新增网关"
                aria-expanded={gatewayPickerOpen}
                onClick={() => setGatewayPickerOpen((prev) => !prev)}
              >
                <Plus className="size-3.5" />
              </button>
              {gatewayPickerOpen && (
                <OnlineControllerPicker
                  controllers={onlineControllers}
                  onPick={(controllerId) => {
                    setGatewayPickerOpen(false);
                    onOpenNewGateway(controllerId);
                  }}
                />
              )}
            </div>
          )}
        </div>
        {gatewayRows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">暂无端口转发网关</p>
        ) : (
          <ul className="space-y-0.5" data-testid="sidebar-gateway-list">
            {gatewayRows.map(({ gateway, controllerId }) => (
              <GatewayItem key={gateway.id} gateway={gateway} controllerId={controllerId} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
