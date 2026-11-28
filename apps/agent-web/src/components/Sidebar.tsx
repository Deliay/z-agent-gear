import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';
import { Cloud, Plus } from 'lucide-react';
import type {
  CloudHostCapabilitiesData,
  GetCloudHostCapabilitiesQuery,
  SessionData,
} from '../graphql/types';
import { CLOUD_HOST_CAPABILITIES } from '../graphql/queries';
import { useCreateSession } from '../hooks/useCreateSession';
import { useHomeOverview } from '../stores/homeOverview';
import NewSessionDialog from './session/NewSessionDialog';
import NewCloudHostDialog from './cloud-host/NewCloudHostDialog';
import GithubProjectSetupDialog from './cloud-host/GithubProjectSetupDialog';
import InstantiateWorkflowDialog from './workflow/InstantiateWorkflowDialog';
import GatewayDialog from './GatewayDialog';
import ContextPanelHeader from './sidebar/ContextPanelHeader';
import ContextPanelFooter from './sidebar/ContextPanelFooter';
import SessionsPanel from './sidebar/SessionsPanel';
import WorkflowsPanel from './sidebar/WorkflowsPanel';
import KnowledgeBasesPanel from './sidebar/KnowledgeBasesPanel';
import HostsPanel from './sidebar/HostsPanel';
import {
  isContextDomainKey,
  persistActiveDomain,
  readActiveDomain,
  type ContextDomainKey,
} from '@/lib/sidebar-prefs';

export interface SidebarProps {
  /** 当前用户展示名（登录响应 User.name） */
  name: string;
  mobile?: boolean;
  /** 受控当前聚焦领域（由 MainLayout 与 ActivityRail 同步） */
  activeDomain?: ContextDomainKey;
  /** 切换领域回调（移动端切换领域时向上同步） */
  onSelectDomain?: (domain: ContextDomainKey) => void;
  /** 兼容旧调用方：一级导航轨点击聚焦的分区 */
  focusTarget?: { section: string; nonce: number } | null;
}

/** 主机选择浮层：实例化工作流前先选主机 */
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

/**
 * Tier 2 — 领域聚焦上下文列表栏（Context Panel，Surface-1 `bg-sidebar`）：
 * - 一次仅渲染当前激活领域的专属视图（会话 / 工作流 / 知识库 / 主机）
 * - 统一顶部工作区切换、领域标题/计数/主新建按钮与本地筛选框
 * - 统一管理领域弹窗与精简底栏
 */
export default function Sidebar({
  name,
  mobile = false,
  activeDomain: controlledDomain,
  onSelectDomain,
  focusTarget,
}: SidebarProps) {
  const navigate = useNavigate();
  const [internalDomain, setInternalDomain] = useState<ContextDomainKey>(readActiveDomain);
  const activeDomain = controlledDomain ?? internalDomain;

  const [filterQuery, setFilterQuery] = useState('');
  const [showNewDialog, setShowNewDialog] = useState<{ controllerId?: string } | null>(null);
  const [showNewCloudHost, setShowNewCloudHost] = useState(false);
  const [showInstantiateDialog, setShowInstantiateDialog] = useState<{
    controllerId: string;
    workspaceId?: string;
  } | null>(null);
  const [showGatewayDialog, setShowGatewayDialog] = useState<string | null>(null);
  const [showGithubSetup, setShowGithubSetup] = useState<{ controllerId: string } | null>(null);
  const [instantiatePickerOpen, setInstantiatePickerOpen] = useState(false);

  const handleDomainChange = useCallback(
    (domain: ContextDomainKey) => {
      setInternalDomain(domain);
      persistActiveDomain(domain);
      onSelectDomain?.(domain);
    },
    [onSelectDomain],
  );

  // 兼容旧 focusTarget 属性
  useEffect(() => {
    if (!focusTarget) return;
    if (isContextDomainKey(focusTarget.section)) {
      setInternalDomain(focusTarget.section);
    }
  }, [focusTarget]);

  // 切换领域时重置本地筛选与浮层
  useEffect(() => {
    setFilterQuery('');
    setInstantiatePickerOpen(false);
  }, [activeDomain]);

  // 首页 + 侧边栏统一数据源（由 MainLayout 的 HOME_OVERVIEW 一次加载）
  const { data, refetch } = useHomeOverview();

  // 云电脑能力查询（仅主机域或新建云电脑入口消费）
  const { data: capabilitiesData } = useQuery<GetCloudHostCapabilitiesQuery>(CLOUD_HOST_CAPABILITIES);
  const capabilities: CloudHostCapabilitiesData | undefined = capabilitiesData?.cloudHostCapabilities;

  const submitCreateSession = useCreateSession();

  const sessions = data?.sessions ?? [];
  const controllers = data?.controllers ?? [];
  const allWorkspaces = data?.workspaces ?? [];
  const workflowInstances = data?.workflowInstances ?? [];
  const sessionReviews = data?.sessionReviews ?? [];

  const githubSetupController = showGithubSetup
    ? controllers.find((controller) => controller.id === showGithubSetup.controllerId)
    : undefined;
  const githubSetupHost = githubSetupController?.cloudHost ?? null;

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

  const getWorkspaceNameForSession = useCallback(
    (session: SessionData): string => {
      if (session.worktreePath) {
        const parts = session.worktreePath.split('/').filter(Boolean);
        const wsName = parts[parts.length - 2];
        const ws = allWorkspaces.find(
          (w) => w.name === wsName && w.controllerId === session.controllerId,
        );
        return ws?.name || wsName || '';
      }
      if (session.cwd && session.cwd.length > 0) {
        let bestMatch = '';
        let bestMatchLength = 0;
        for (const w of allWorkspaces) {
          if (w.controllerId !== session.controllerId || !w.isEnabled) continue;
          if (session.cwd.startsWith(w.path)) {
            const rest = session.cwd.slice(w.path.length);
            if (rest === '' || rest.startsWith('/')) {
              if (w.path.length > bestMatchLength) {
                bestMatchLength = w.path.length;
                bestMatch = w.name;
              }
            }
          }
        }
        return bestMatch;
      }
      return '';
    },
    [allWorkspaces],
  );

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
    const sessionId = await submitCreateSession(
      controllerId,
      acpServerType,
      workspaceId,
      enableWorktree,
      worktreeBranchSuffix,
      mcpServerIds,
      existingWorktreePath,
      modeId,
      modelId,
      customMcpServerIds,
    );
    if (sessionId) {
      setShowNewDialog(null);
    }
  };

  // 各领域标题、计数与主新建按钮
  let headerTitle = '会话';
  let headerCount: number | undefined = sessions.length;
  let headerAction: React.ReactNode = null;
  let showFilter = false;

  if (activeDomain === 'sessions') {
    headerTitle = '会话';
    headerCount = sessions.length;
    showFilter = true;
    headerAction = (
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="新建会话"
        aria-label="新建会话"
        onClick={() => setShowNewDialog({})}
      >
        <Plus className="size-3.5" />
        <span>新建</span>
      </button>
    );
  } else if (activeDomain === 'workflows') {
    headerTitle = '工作流';
    headerCount = workflowInstances.length;
    showFilter = true;
    headerAction =
      controllers.length > 0 ? (
        <div className="relative">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="实例化工作流"
            aria-label="实例化工作流"
            aria-expanded={instantiatePickerOpen}
            onClick={() => setInstantiatePickerOpen((prev) => !prev)}
          >
            <Plus className="size-3.5" />
            <span>实例化</span>
          </button>
          {instantiatePickerOpen && (
            <ControllerPicker
              controllers={controllers}
              onPick={(controllerId) => {
                setInstantiatePickerOpen(false);
                setShowInstantiateDialog({ controllerId });
              }}
            />
          )}
        </div>
      ) : null;
  } else if (activeDomain === 'knowledgeBases') {
    headerTitle = '知识库';
    headerCount = undefined;
    showFilter = false;
  } else if (activeDomain === 'hosts') {
    headerTitle = '主机';
    headerCount = controllers.length;
    showFilter = false;
    headerAction = capabilities?.enabled ? (
      <button
        type="button"
        aria-label="新建云电脑"
        title="新建云电脑"
        onClick={() => setShowNewCloudHost(true)}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Cloud className="size-3.5" />
        <span>新建云电脑</span>
      </button>
    ) : null;
  }

  return (
    <nav
      className={`flex min-w-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground ${
        mobile ? 'h-full' : 'h-screen'
      }`}
      aria-label="侧边栏导航"
    >
      <ContextPanelHeader
        activeDomain={activeDomain}
        title={headerTitle}
        count={headerCount}
        action={headerAction}
        showFilter={showFilter}
        filterQuery={filterQuery}
        onFilterChange={setFilterQuery}
        mobile={mobile}
        onSelectDomain={handleDomainChange}
      />

      {activeDomain === 'sessions' && (
        <SessionsPanel
          sessions={sessions}
          controllers={controllers}
          sessionReviews={sessionReviews}
          filterQuery={filterQuery}
          onClearFilter={() => setFilterQuery('')}
          resolveWorkspaceName={getWorkspaceNameForSession}
        />
      )}

      {activeDomain === 'workflows' && (
        <WorkflowsPanel
          workflowInstances={workflowInstances}
          filterQuery={filterQuery}
          onClearFilter={() => setFilterQuery('')}
        />
      )}

      {activeDomain === 'knowledgeBases' && <KnowledgeBasesPanel />}

      {activeDomain === 'hosts' && (
        <HostsPanel
          controllers={controllers}
          allWorkspaces={allWorkspaces}
          sessions={sessions}
          resolveWorkspaceName={getWorkspaceNameForSession}
          onCreateSession={handleCreateSession}
          onOpenNewSession={(controllerId) => setShowNewDialog({ controllerId })}
          onOpenGithubSetup={(controllerId) => setShowGithubSetup({ controllerId })}
          onOpenNewGateway={(controllerId) => setShowGatewayDialog(controllerId)}
        />
      )}

      <ContextPanelFooter name={name} mobile={mobile} />

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
    </nav>
  );
}
