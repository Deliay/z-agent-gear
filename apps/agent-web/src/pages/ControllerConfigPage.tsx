import { useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { GET_CONTROLLERS } from '@/graphql/queries';
import type { CloudHostData, GetControllersQuery } from '@/graphql/types';
import WorkspaceSection from '@/components/settings/WorkspaceSection';
import HarnessToolsSection from '@/components/settings/HarnessToolsSection';
import StopCloudHostDialog from '@/components/cloud-host/StopCloudHostDialog';
import DeleteCloudHostDialog from '@/components/cloud-host/DeleteCloudHostDialog';
import CloudHostWorkloadsSection from '@/components/cloud-host/CloudHostWorkloadsSection';
import CloudHostIssuesLinkageSection from '@/components/cloud-host/CloudHostIssuesLinkageSection';
import GithubProjectSetupDialog from '@/components/cloud-host/GithubProjectSetupDialog';
import McpDefaultSection from '@/components/settings/McpDefaultSection';
import {
  canDeleteCloudHost,
  canStopCloudHost,
  cloudHostStatusDotClass,
  cloudHostStatusLabel,
} from '@/components/cloud-host/cloud-host-status';
import { useHomeOverview } from '@/stores/homeOverview';
import { useIsMobile } from '../hooks/useIsMobile';
import MobileBackButton from '../components/MobileBackButton';
import { Button } from '@/components/ui/button';
import { Cloud, GitBranch } from 'lucide-react';

interface ControllerConfigPageProps {
  controllerId: string;
  onBack: () => void;
}

/**
 * 云电脑信息面板：状态 / 失败原因 / 活动会话数 / 停止 / 删除。
 * 工作区与 Harness 工具两栏与普通主机完全一致，面板只做额外汇总。
 */
function CloudHostPanel({
  cloudHost,
  onStop,
  onDelete,
}: {
  cloudHost: CloudHostData;
  onStop: () => void;
  onDelete: () => void;
}) {
  const stoppable = canStopCloudHost(cloudHost);
  const deletable = canDeleteCloudHost(cloudHost);

  return (
    <div data-testid="cloud-host-panel" className="mb-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Cloud className="size-4 shrink-0" />
          <span className="font-medium">云电脑</span>
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs">
            <span className={`h-2 w-2 rounded-full ${cloudHostStatusDotClass(cloudHost.status)}`} />
            {cloudHostStatusLabel(cloudHost.status)}
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
      {cloudHost.failureReason && (
        <p className="mt-2 break-words text-sm text-destructive" data-testid="cloud-host-failure-reason">
          失败原因：{cloudHost.failureReason}
        </p>
      )}
    </div>
  );
}

export default function ControllerConfigPage({ controllerId, onBack }: ControllerConfigPageProps) {
  const { data: controllerData, refetch } = useQuery<GetControllersQuery>(GET_CONTROLLERS);
  const { refetch: refetchHome } = useHomeOverview();
  const controller = controllerData?.controllers.find((c) => c.id === controllerId);
  const cloudHost = controller?.type === 'cloud' ? controller.cloudHost : null;
  const isMobile = useIsMobile();

  const [activeSection, setActiveSection] = useState<'workspace' | 'harness' | 'mcp' | 'workloads' | 'github'>('workspace');
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [githubSetupOpen, setGithubSetupOpen] = useState(false);

  const refreshHostData = () => {
    void refetch();
    refetchHome();
  };

  const workloadsSection = cloudHost ? (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          安装后立即在云电脑内生效，不提供卸载。
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
      <CloudHostWorkloadsSection
        controllerId={controllerId}
        cloudHost={cloudHost}
        onChanged={refreshHostData}
      />
    </div>
  ) : null;

  const githubSection = cloudHost ? (
    <CloudHostIssuesLinkageSection controllerId={controllerId} onConfigureWorkflow={onBack} />
  ) : null;

  const panel = cloudHost ? (
    <CloudHostPanel
      cloudHost={cloudHost}
      onStop={() => setStopDialogOpen(true)}
      onDelete={() => setDeleteDialogOpen(true)}
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
        </div>
        <div className="flex-1 overflow-y-auto" data-testid="mobile-section-scroll">
          {panel && <div className="px-4 pt-4">{panel}</div>}
          <div className="p-4">
            {activeSection === 'workspace' && (
              <WorkspaceSection controllerId={controllerId} controllerOnline={controller?.status === 'online'} />
            )}
            {activeSection === 'harness' && (
              <HarnessToolsSection controllerId={controllerId} />
            )}
            {activeSection === 'mcp' && controller && (
              <McpDefaultSection controller={controller} />
            )}
            {activeSection === 'workloads' && workloadsSection}
            {activeSection === 'github' && githubSection}
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
          </div>
        </div>
      </nav>
      <div className="overflow-y-auto p-8">
        {panel}
        {activeSection === 'workspace' ? (
          <WorkspaceSection controllerId={controllerId} controllerOnline={controller?.status === 'online'} />
        ) : activeSection === 'harness' ? (
          <HarnessToolsSection controllerId={controllerId} />
        ) : activeSection === 'mcp' ? (
          controller ? <McpDefaultSection controller={controller} /> : null
        ) : activeSection === 'github' ? (
          githubSection
        ) : (
          workloadsSection
        )}
      </div>
      {dialogs}
    </div>
  );
}
