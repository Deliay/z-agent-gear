import { useState } from 'react';
import { useApolloClient, useQuery } from '@apollo/client/react';
import { GET_CONTROLLERS, GET_CONTROLLER_WORKSPACES } from '@/graphql/queries';
import type { CloudHostData, CloudHostSetupOperationData, GetControllerWorkspacesQuery, GetControllersQuery } from '@/graphql/types';
import WorkspaceSection from '@/components/settings/WorkspaceSection';
import HarnessToolsSection from '@/components/settings/HarnessToolsSection';
import StopCloudHostDialog from '@/components/cloud-host/StopCloudHostDialog';
import DeleteCloudHostDialog from '@/components/cloud-host/DeleteCloudHostDialog';
import CloudHostWorkloadsSection from '@/components/cloud-host/CloudHostWorkloadsSection';
import CloudHostIssuesLinkageSection from '@/components/cloud-host/CloudHostIssuesLinkageSection';
import GithubProjectSetupDialog from '@/components/cloud-host/GithubProjectSetupDialog';
import McpDefaultSection from '@/components/settings/McpDefaultSection';
import RepoWorkflowSection from '@/components/cloud-host/RepoWorkflowSection';
import RepoWorkflowPromptDialog from '@/components/cloud-host/RepoWorkflowPromptDialog';
import ConfigureRepoWorkflowDialog from '@/components/workflow/ConfigureRepoWorkflowDialog';
import { REPO_WORKFLOW_TEMPLATES, type RepoWorkflowTemplateData } from '@/graphql/workflow';
import { isRepoTemplateScanSupported } from '@/lib/repo-workflow';
import {
  hasPromptedRepoWorkflow,
  markRepoWorkflowPrompted,
} from '@/stores/repo-workflow-prompt';
import {
  canDeleteCloudHost,
  canStopCloudHost,
  cloudHostStatusDotClass,
  cloudHostStatusText,
} from '@/components/cloud-host/cloud-host-status';
import { cloudStorageStatusLabel } from '@/lib/cloud-storage';
import { useHomeOverview } from '@/stores/homeOverview';
import { useIsMobile } from '../hooks/useIsMobile';
import MobileBackButton from '../components/MobileBackButton';
import { Button } from '@/components/ui/button';
import { Cloud, GitBranch, HardDrive } from 'lucide-react';

interface ControllerConfigPageProps {
  controllerId: string;
  onBack: () => void;
  /** 跳转到设置页「云存储」区块（云电脑配置页已挂载存储入口） */
  onOpenStorage?: () => void;
}

/**
 * 云电脑信息面板：状态 / 失败原因 / 活动会话数 / 停止 / 删除。
 * 工作区与 Harness 工具两栏与普通主机完全一致，面板只做额外汇总。
 */
function CloudHostPanel({
  cloudHost,
  onStop,
  onDelete,
  onOpenStorage,
}: {
  cloudHost: CloudHostData;
  onStop: () => void;
  onDelete: () => void;
  onOpenStorage: () => void;
}) {
  const stoppable = canStopCloudHost(cloudHost);
  const deletable = canDeleteCloudHost(cloudHost);
  const showStorage =
    Boolean(cloudHost.storage) &&
    (cloudHost.status === 'RUNNING' || cloudHost.status === 'STOPPED');

  return (
    <div data-testid="cloud-host-panel" className="mb-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Cloud className="size-4 shrink-0" />
          <span className="font-medium">云电脑</span>
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs">
            <span className={`h-2 w-2 rounded-full ${cloudHostStatusDotClass(cloudHost.status)}`} />
            {cloudHostStatusText(cloudHost)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(stoppable || cloudHost.status === 'STOPPING') && (
            <Button
              variant="destructive"
              size="sm"
              onClick={onStop}
              disabled={!stoppable || cloudHost.status === 'STOPPING'}
            >
              {cloudHost.status === 'STOPPING' ? '停止中...' : '停止云电脑'}
            </Button>
          )}
          {deletable && (
            <Button variant="outline" size="sm" onClick={onDelete}>
              删除云电脑
            </Button>
          )}
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">活动会话</dt>
          <dd>{cloudHost.activeSessionCount}</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-xs text-muted-foreground">Harness 工具</dt>
          <dd className="break-words">{cloudHost.harnessTypes.join(', ') || '—'}</dd>
        </div>
      </dl>
      {showStorage && cloudHost.storage && (
        <div
          className="mt-3 flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border p-3 text-sm"
          data-testid="cloud-host-storage"
        >
          <HardDrive className="size-4 shrink-0" />
          <span className="font-medium">云存储</span>
          <span className="min-w-0 break-words text-muted-foreground">
            {cloudHost.storage.name} · {cloudHost.storage.sizeGi}Gi ·{' '}
            {cloudStorageStatusLabel(cloudHost.storage.status)}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={onOpenStorage}
          >
            查看云存储设置
          </Button>
        </div>
      )}
      {cloudHost.failureReason && (
        <p className="mt-2 break-words text-sm text-destructive" data-testid="cloud-host-failure-reason">
          失败原因：{cloudHost.failureReason}
        </p>
      )}
    </div>
  );
}

export default function ControllerConfigPage({ controllerId, onBack, onOpenStorage }: ControllerConfigPageProps) {
  const { data: controllerData, refetch } = useQuery<GetControllersQuery>(GET_CONTROLLERS);
  const { refetch: refetchHome } = useHomeOverview();
  const controller = controllerData?.controllers.find((c) => c.id === controllerId);
  const cloudHost = controller?.type === 'cloud' ? controller.cloudHost : null;
  const isMobile = useIsMobile();

  const [activeSection, setActiveSection] = useState<'workspace' | 'harness' | 'mcp' | 'workloads' | 'github' | 'workflow'>('workspace');
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [githubSetupOpen, setGithubSetupOpen] = useState(false);
  const client = useApolloClient();
  const [repoPrompt, setRepoPrompt] = useState<{
    workspaceId: string;
    templates: RepoWorkflowTemplateData[];
  } | null>(null);
  const [repoConfigure, setRepoConfigure] = useState<{
    workspaceId: string;
    template: RepoWorkflowTemplateData;
  } | null>(null);

  const refreshHostData = () => {
    void refetch();
    refetchHome();
  };

  /**
   * 检测项目工作流模板（D4/D5）：仅云电脑 RUNNING 且控制器版本支持、同会话未提示过时发起一次；
   * 存在合法模板才弹提示（空结果/失败/版本不足均不打扰）。
   */
  const detectRepoWorkflow = async (workspaceId: string) => {
    if (!cloudHost || cloudHost.status !== 'RUNNING' || cloudHost.deletedAt) return;
    if (!isRepoTemplateScanSupported(controller?.version)) return;
    if (hasPromptedRepoWorkflow(workspaceId)) return;
    try {
      const result = await client.query<{ repoWorkflowTemplates: RepoWorkflowTemplateData[] }>({
        query: REPO_WORKFLOW_TEMPLATES,
        variables: { workspaceId },
        fetchPolicy: 'network-only',
      });
      const valid = (result.data?.repoWorkflowTemplates ?? []).filter((item) => item.valid);
      if (valid.length === 0) return;
      markRepoWorkflowPrompted(workspaceId);
      setRepoPrompt({ workspaceId, templates: valid });
    } catch {
      // 扫描失败降级不打扰（可手动在「工作流」区块重新检测）
    }
  };

  /** GitHub 项目设置成功：refetch 工作区列表，按 path === defaultWorkspace 定位后检测（D4）。 */
  const handleGithubFinished = async (operation: CloudHostSetupOperationData) => {
    if (operation.status !== 'SUCCEEDED' || !cloudHost?.defaultWorkspace) return;
    try {
      const result = await client.query<GetControllerWorkspacesQuery>({
        query: GET_CONTROLLER_WORKSPACES,
        variables: { controllerId },
        fetchPolicy: 'network-only',
      });
      const workspace = (result.data?.controllerWorkspaces ?? []).find(
        (item) => item.path === cloudHost.defaultWorkspace,
      );
      if (workspace) void detectRepoWorkflow(workspace.id);
    } catch {
      // 工作区列表取数失败不打扰
    }
  };

  const workloadsSection = cloudHost ? (
    <div className="min-w-0 space-y-4">
      <p className="text-sm text-muted-foreground">
        安装后立即在云电脑内生效，不提供卸载。
      </p>
      <CloudHostWorkloadsSection
        controllerId={controllerId}
        cloudHost={cloudHost}
        onChanged={refreshHostData}
      />
    </div>
  ) : null;

  const githubSection = cloudHost ? (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Github 项目设置：安装后自动克隆仓库并初始化项目工作区。
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Github 项目设置"
          disabled={cloudHost.status !== 'RUNNING' || Boolean(cloudHost.deletedAt)}
          onClick={() => setGithubSetupOpen(true)}
        >
          <GitBranch className="size-3.5" />
          Github 项目设置
        </Button>
      </div>
      <CloudHostIssuesLinkageSection controllerId={controllerId} onConfigureWorkflow={onBack} />
    </div>
  ) : null;

  const workflowSection = cloudHost ? (
    <RepoWorkflowSection
      controllerId={controllerId}
      controllerVersion={controller?.version}
      cloudHost={cloudHost}
      onChanged={refreshHostData}
    />
  ) : null;

  const panel = cloudHost ? (
    <CloudHostPanel
      cloudHost={cloudHost}
      onStop={() => setStopDialogOpen(true)}
      onDelete={() => setDeleteDialogOpen(true)}
      onOpenStorage={() => (onOpenStorage ?? onBack)()}
    />
  ) : null;

  const dialogs = cloudHost && controller ? (
    <>
      <StopCloudHostDialog
        open={stopDialogOpen}
        cloudHost={cloudHost}
        onClose={() => setStopDialogOpen(false)}
        onStopped={() => {
          setStopDialogOpen(false);
          refreshHostData();
        }}
      />
      <DeleteCloudHostDialog
        open={deleteDialogOpen}
        cloudHost={cloudHost}
        controllerId={controllerId}
        onClose={() => setDeleteDialogOpen(false)}
        onDeleted={() => {
          setDeleteDialogOpen(false);
          refreshHostData();
          onBack();
        }}
      />
      <GithubProjectSetupDialog
        open={githubSetupOpen}
        controllerId={controller.id}
        cloudHost={cloudHost}
        onClose={() => {
          setGithubSetupOpen(false);
          refreshHostData();
        }}
        onFinished={handleGithubFinished}
      />
      <RepoWorkflowPromptDialog
        open={Boolean(repoPrompt)}
        onOpenChange={(open) => {
          if (!open) setRepoPrompt(null);
        }}
        workspaceId={repoPrompt?.workspaceId ?? ''}
        templates={repoPrompt?.templates ?? []}
        onConfigure={(template) => {
          if (!repoPrompt) return;
          setRepoConfigure({ workspaceId: repoPrompt.workspaceId, template });
          setRepoPrompt(null);
        }}
      />
      <ConfigureRepoWorkflowDialog
        open={Boolean(repoConfigure)}
        onOpenChange={(open) => {
          if (!open) setRepoConfigure(null);
        }}
        workspaceId={repoConfigure?.workspaceId ?? ''}
        controllerId={controllerId}
        template={repoConfigure?.template ?? null}
      />
    </>
  ) : null;

  if (isMobile) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <MobileBackButton to="/settings" />
          <span className={`h-2 w-2 rounded-full shrink-0 ${controller?.status === 'online' ? 'bg-success' : 'bg-muted-foreground'}`} />
          <span className="font-medium truncate">{controller?.name || '加载中...'}</span>
        </div>
        {/* tab 常驻在滚动容器外，内容滚动时仍可切换 */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-4 py-2">
          <button type="button" data-testid="config-tab-workspace" onClick={() => setActiveSection('workspace')} className={`rounded-md px-3 py-1.5 text-sm font-medium ${activeSection === 'workspace' ? 'bg-accent' : 'hover:bg-accent'}`}>工作区</button>
          <button type="button" data-testid="config-tab-harness" onClick={() => setActiveSection('harness')} className={`rounded-md px-3 py-1.5 text-sm font-medium ${activeSection === 'harness' ? 'bg-accent' : 'hover:bg-accent'}`}>Harness 工具</button>
          <button type="button" data-testid="config-tab-mcp" onClick={() => setActiveSection('mcp')} className={`rounded-md px-3 py-1.5 text-sm font-medium ${activeSection === 'mcp' ? 'bg-accent' : 'hover:bg-accent'}`}>默认 MCP</button>
          {cloudHost && (
            <button type="button" data-testid="config-tab-workloads" onClick={() => setActiveSection('workloads')} className={`rounded-md px-3 py-1.5 text-sm font-medium ${activeSection === 'workloads' ? 'bg-accent' : 'hover:bg-accent'}`}>工作负载</button>
          )}
          {cloudHost && (
            <button type="button" data-testid="config-tab-github" onClick={() => setActiveSection('github')} className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium ${activeSection === 'github' ? 'bg-accent' : 'hover:bg-accent'}`}>Github</button>
          )}
          {cloudHost && (
            <button type="button" data-testid="config-tab-workflow" onClick={() => setActiveSection('workflow')} className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium ${activeSection === 'workflow' ? 'bg-accent' : 'hover:bg-accent'}`}>工作流</button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto" data-testid="mobile-section-scroll">
          {panel && <div className="px-4 pt-4">{panel}</div>}
          <div className="p-4">
            {activeSection === 'workspace' && (
              <WorkspaceSection
                controllerId={controllerId}
                controllerOnline={controller?.status === 'online'}
                onWorkspaceCreated={(workspace) => void detectRepoWorkflow(workspace.id)}
              />
            )}
            {activeSection === 'harness' && (
              <HarnessToolsSection controllerId={controllerId} />
            )}
            {activeSection === 'mcp' && controller && (
              <McpDefaultSection controller={controller} />
            )}
            {activeSection === 'workloads' && workloadsSection}
            {activeSection === 'github' && githubSection}
            {activeSection === 'workflow' && workflowSection}
          </div>
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-[200px_1fr]">
      <nav className="border-r p-4">
        <div className="space-y-1">
          <button
            type="button"
            onClick={onBack}
            className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground"
          >
            ← 返回
          </button>
          <div className="mt-4 flex items-center gap-2 px-3">
          <span className={`h-2 w-2 rounded-full shrink-0 ${controller?.status === 'online' ? 'bg-success' : 'bg-muted-foreground'}`} />
            <span className="font-medium truncate">{controller?.name || '加载中...'}</span>
          </div>
          <div className="mt-6 space-y-1">
            <button
              type="button"
              data-testid="config-tab-workspace"
              onClick={() => setActiveSection('workspace')}
              className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'workspace' ? 'bg-accent' : 'hover:bg-accent'}`}
            >
              工作区
            </button>
            <button
              type="button"
              data-testid="config-tab-harness"
              onClick={() => setActiveSection('harness')}
              className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'harness' ? 'bg-accent' : 'hover:bg-accent'}`}
            >
              可用 Harness 工具
            </button>
            <button
              type="button"
              data-testid="config-tab-mcp"
              onClick={() => setActiveSection('mcp')}
              className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'mcp' ? 'bg-accent' : 'hover:bg-accent'}`}
            >
              默认 MCP
            </button>
            {cloudHost && (
              <button
                type="button"
                data-testid="config-tab-workloads"
                onClick={() => setActiveSection('workloads')}
                className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'workloads' ? 'bg-accent' : 'hover:bg-accent'}`}
              >
                工作负载
              </button>
            )}
            {cloudHost && (
              <button
                type="button"
                data-testid="config-tab-github"
                onClick={() => setActiveSection('github')}
                className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'github' ? 'bg-accent' : 'hover:bg-accent'}`}
              >
                Github
              </button>
            )}
            {cloudHost && (
              <button
                type="button"
                data-testid="config-tab-workflow"
                onClick={() => setActiveSection('workflow')}
                className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'workflow' ? 'bg-accent' : 'hover:bg-accent'}`}
              >
                工作流
              </button>
            )}
          </div>
        </div>
      </nav>
      <div className="overflow-y-auto p-8">
        {panel}
        {activeSection === 'workspace' ? (
          <WorkspaceSection
            controllerId={controllerId}
            controllerOnline={controller?.status === 'online'}
            onWorkspaceCreated={(workspace) => void detectRepoWorkflow(workspace.id)}
          />
        ) : activeSection === 'harness' ? (
          <HarnessToolsSection controllerId={controllerId} />
        ) : activeSection === 'mcp' ? (
          controller ? <McpDefaultSection controller={controller} /> : null
        ) : activeSection === 'github' ? (
          githubSection
        ) : activeSection === 'workflow' ? (
          workflowSection
        ) : (
          workloadsSection
        )}
      </div>
      {dialogs}
    </div>
  );
}
