import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ControllerConfigPage from '../ControllerConfigPage';
import type { CloudHostData, ControllerData } from '@/graphql/types';
import { resetRepoWorkflowPrompted } from '@/stores/repo-workflow-prompt';

const mockUseQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockMutate = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockUseApolloClient = vi.fn(() => ({ query: mockClientQuery }));
const mockIsMobile = vi.fn(() => false);
const mockNavigate = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useApolloClient: () => mockUseApolloClient(),
  useMutation: () => [mockMutate, { loading: false }],
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/components/settings/WorkspaceSection', () => ({
  default: ({ onWorkspaceCreated }: { onWorkspaceCreated?: (w: { id: string }) => void }) => (
    <div data-testid="workspace-section">
      WorkspaceSection
      <button type="button" onClick={() => onWorkspaceCreated?.({ id: 'ws-1' })}>
        mock-workspace-created
      </button>
    </div>
  ),
}));

vi.mock('@/components/settings/HarnessToolsSection', () => ({
  default: () => <div data-testid="harness-section">HarnessToolsSection</div>,
}));

vi.mock('@/components/cloud-host/StopCloudHostDialog', () => ({
  default: ({ open }: { open: boolean }) => open ? <div data-testid="stop-cloud-host-dialog" /> : null,
}));

vi.mock('@/components/cloud-host/DeleteCloudHostDialog', () => ({
  default: ({ open }: { open: boolean }) => open ? <div data-testid="delete-cloud-host-dialog" /> : null,
}));

vi.mock('@/components/cloud-host/CloudHostWorkloadsSection', () => ({
  default: ({ controllerId, cloudHost }: { controllerId: string; cloudHost: CloudHostData }) => (
    <div data-testid="cloud-host-workloads-section" data-controller-id={controllerId}>
      {cloudHost.name}
    </div>
  ),
}));

vi.mock('@/components/cloud-host/CloudHostIssuesLinkageSection', () => ({
  default: ({ controllerId }: { controllerId: string }) => (
    <div data-testid="cloud-host-issues-linkage-section" data-controller-id={controllerId} />
  ),
}));

vi.mock('@/components/cloud-host/GithubProjectSetupDialog', () => ({
  default: ({ open, controllerId, cloudHost, onFinished }: {
    open: boolean;
    controllerId: string;
    cloudHost: CloudHostData;
    onFinished?: (operation: { status: string }) => void;
  }) => open ? (
    <div data-testid="github-setup-dialog" data-controller-id={controllerId}>
      {cloudHost.name}
      <button type="button" onClick={() => onFinished?.({ status: 'SUCCEEDED' })}>
        mock-github-finished
      </button>
    </div>
  ) : null,
}));

vi.mock('@/components/settings/McpDefaultSection', () => ({
  default: ({ controller }: { controller: ControllerData }) => (
    <div data-testid="mcp-default-section" data-controller-id={controller.id} />
  ),
}));

vi.mock('@/components/cloud-host/RepoWorkflowSection', () => ({
  default: ({ controllerId, controllerVersion }: { controllerId: string; controllerVersion?: string | null }) => (
    <div data-testid="repo-workflow-section" data-controller-id={controllerId} data-version={controllerVersion} />
  ),
}));

vi.mock('@/components/cloud-host/RepoWorkflowPromptDialog', () => ({
  default: ({ open, templates }: { open: boolean; templates: unknown[] }) =>
    open ? <div data-testid="repo-workflow-prompt-dialog">{templates.length}</div> : null,
}));

vi.mock('@/components/workflow/ConfigureRepoWorkflowDialog', () => ({
  default: ({ open, template }: { open: boolean; template: { fileName: string } | null }) =>
    open ? <div data-testid="configure-repo-workflow-dialog">{template?.fileName}</div> : null,
}));

function makeCloudHost(overrides: Partial<CloudHostData> = {}): CloudHostData {
  return {
    id: 'cloud-1',
    name: '云电脑 A',
    controllerId: 'ctrl-1',
    status: 'RUNNING',
    harnessTypes: ['OPENCODE'],
    defaultSessionId: null,
    activeSessionCount: 0,
    failureReason: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeController(overrides: Partial<ControllerData> = {}): ControllerData {
  return {
    id: 'ctrl-1',
    name: 'My Machine',
    hostname: 'host-1',
    type: 'local',
    status: 'online',
    keyId: 'key-1',
    version: '1.0.0',
    lastHeartbeatAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockControllers(controllers: ControllerData[], loading = false) {
  mockUseQuery.mockReturnValue({ data: { controllers }, loading, refetch: vi.fn() });
}

describe('ControllerConfigPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
  });

  const defaultProps = {
    controllerId: 'ctrl-1',
    onBack: vi.fn(),
  };

  it('should render back button', () => {
    mockControllers([]);

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByText('← 返回')).toBeDefined();
  });

  it('should call onBack when back button clicked', () => {
    const onBack = vi.fn();
    mockControllers([]);

    render(<ControllerConfigPage {...defaultProps} onBack={onBack} />);

    fireEvent.click(screen.getByText('← 返回'));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('should show controller name and online status', () => {
    mockControllers([makeController()]);

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByText('My Machine')).toBeDefined();
  });

  it('should show loading text when controller data loading', () => {
    mockUseQuery.mockReturnValue({ data: null, loading: true, refetch: vi.fn() });

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('should render WorkspaceSection by default', () => {
    mockControllers([]);

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByTestId('workspace-section')).toBeDefined();
    expect(screen.queryByTestId('harness-section')).toBeNull();
  });

  it('should switch to HarnessToolsSection when clicking harness nav', () => {
    mockControllers([]);

    render(<ControllerConfigPage {...defaultProps} />);

    fireEvent.click(screen.getByText('可用 Harness 工具'));

    expect(screen.getByTestId('harness-section')).toBeDefined();
    expect(screen.queryByTestId('workspace-section')).toBeNull();
  });

  it('should switch back to WorkspaceSection when clicking workspace nav', () => {
    mockControllers([]);

    render(<ControllerConfigPage {...defaultProps} />);

    fireEvent.click(screen.getByText('可用 Harness 工具'));
    fireEvent.click(screen.getByText('工作区'));

    expect(screen.getByTestId('workspace-section')).toBeDefined();
  });

  it('should render section nav buttons', () => {
    mockControllers([]);

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByText('工作区')).toBeDefined();
    expect(screen.getByText('可用 Harness 工具')).toBeDefined();
  });

  describe('云电脑配置页', () => {
    it('T-AW6/T-AW12 RUNNING 云电脑展示状态、活动会话数、停止按钮，且工作区/Harness 两栏一致', () => {
      mockControllers([
        makeController({
          type: 'cloud',
          cloudHost: makeCloudHost({ status: 'RUNNING', activeSessionCount: 2 }),
        }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      expect(screen.getByTestId('cloud-host-panel')).toBeInTheDocument();
      expect(screen.getByText('运行中')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '停止云电脑' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '删除云电脑' })).not.toBeInTheDocument();
      expect(screen.getByTestId('workspace-section')).toBeInTheDocument();

      fireEvent.click(screen.getByText('可用 Harness 工具'));
      expect(screen.getByTestId('harness-section')).toBeInTheDocument();
    });

    it('T-AW9 STOPPED 云电脑展示删除入口、无停止入口', () => {
      mockControllers([
        makeController({ type: 'cloud', cloudHost: makeCloudHost({ status: 'STOPPED' }) }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      expect(screen.getByText('已销毁')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '删除云电脑' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '停止云电脑' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '删除云电脑' }));
      expect(screen.getByTestId('delete-cloud-host-dialog')).toBeInTheDocument();
    });

    it('FAILED 云电脑展示失败原因并可删除', () => {
      mockControllers([
        makeController({
          type: 'cloud',
          cloudHost: makeCloudHost({ status: 'FAILED', failureReason: 'container exited' }),
        }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      expect(screen.getByTestId('cloud-host-failure-reason')).toHaveTextContent('失败原因：container exited');
      expect(screen.getByRole('button', { name: '删除云电脑' })).toBeInTheDocument();
    });

    it('T-AW9 RUNNING 无删除入口，点击停止打开停止对话框', () => {
      mockControllers([
        makeController({ type: 'cloud', cloudHost: makeCloudHost({ status: 'RUNNING' }) }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      expect(screen.queryByRole('button', { name: '删除云电脑' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '停止云电脑' }));
      expect(screen.getByTestId('stop-cloud-host-dialog')).toBeInTheDocument();
    });

    it('T-AW11 普通主机不展示云电脑面板/停止/删除', () => {
      mockControllers([makeController({ type: 'local' })]);

      render(<ControllerConfigPage {...defaultProps} />);

      expect(screen.queryByTestId('cloud-host-panel')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '停止云电脑' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '删除云电脑' })).not.toBeInTheDocument();
    });

    it('RUNNING/STOPPED 云电脑展示已挂载云存储并可跳转设置', () => {
      const onOpenStorage = vi.fn();
      mockControllers([
        makeController({
          type: 'cloud',
          cloudHost: makeCloudHost({
            status: 'RUNNING',
            storage: {
              id: 'st-1',
              name: '设计资料',
              sizeGi: 20,
              status: 'ATTACHED',
              usageBytes: 1024,
              hourlyCredits: 15,
            },
          }),
        }),
      ]);

      render(
        <ControllerConfigPage {...defaultProps} onOpenStorage={onOpenStorage} />,
      );

      expect(screen.getByTestId('cloud-host-storage')).toHaveTextContent('设计资料');
      expect(screen.getByTestId('cloud-host-storage')).toHaveTextContent('20Gi');
      expect(screen.getByTestId('cloud-host-storage')).toHaveTextContent('已挂载');
      fireEvent.click(screen.getByRole('button', { name: '查看云存储设置' }));
      expect(onOpenStorage).toHaveBeenCalledOnce();
    });

    it('STARTING 云电脑不展示已挂载云存储', () => {
      mockControllers([
        makeController({
          type: 'cloud',
          cloudHost: makeCloudHost({
            status: 'STARTING',
            storage: {
              id: 'st-1',
              name: '设计资料',
              sizeGi: 20,
              status: 'ATTACHING',
              usageBytes: null,
              hourlyCredits: 15,
            },
          }),
        }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      expect(screen.queryByTestId('cloud-host-storage')).not.toBeInTheDocument();
    });

    it('T-AW-G1/G12 云电脑展示工作负载页签与 Github 页签入口', () => {
      mockControllers([
        makeController({ type: 'cloud', cloudHost: makeCloudHost({ status: 'RUNNING' }) }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: '工作负载' }));
      expect(screen.getByTestId('cloud-host-workloads-section')).toHaveAttribute('data-controller-id', 'ctrl-1');

      fireEvent.click(screen.getByTestId('config-tab-github'));
      const githubButton = screen.getByRole('button', { name: 'Github 项目设置' });
      expect(githubButton).not.toBeDisabled();
      fireEvent.click(githubButton);

      expect(screen.getByTestId('github-setup-dialog')).toHaveAttribute('data-controller-id', 'ctrl-1');
    });

    it('T-AW-G13 非 RUNNING 云电脑的 Github 入口禁用', () => {
      mockControllers([
        makeController({ type: 'cloud', cloudHost: makeCloudHost({ status: 'STOPPED' }) }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      fireEvent.click(screen.getByTestId('config-tab-github'));
      expect(screen.getByRole('button', { name: 'Github 项目设置' })).toBeDisabled();
    });

    it('T-AW-G14 工作负载页签不再出现 Github 入口；Github 页签展示', () => {
      mockControllers([
        makeController({ type: 'cloud', cloudHost: makeCloudHost({ status: 'RUNNING' }) }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: '工作负载' }));
      expect(screen.queryByRole('button', { name: 'Github 项目设置' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('config-tab-github'));
      expect(screen.getByRole('button', { name: 'Github 项目设置' })).toBeInTheDocument();
    });

    it('普通主机不展示工作负载页签与 Github 入口', () => {
      mockControllers([makeController({ type: 'local' })]);

      render(<ControllerConfigPage {...defaultProps} />);

      expect(screen.queryByRole('button', { name: '工作负载' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Github 项目设置' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('cloud-host-workloads-section')).not.toBeInTheDocument();
    });
  });

  describe('移动端布局（D-10）', () => {
    it('tab 常驻在滚动容器外，两个 tab 均可切换', () => {
      mockIsMobile.mockReturnValue(true);
      mockControllers([
        makeController({ type: 'cloud', cloudHost: makeCloudHost({ status: 'RUNNING' }) }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      const scrollArea = screen.getByTestId('mobile-section-scroll');
      const workspaceTab = screen.getByRole('button', { name: '工作区' });
      const harnessTab = screen.getByRole('button', { name: 'Harness 工具' });

      expect(scrollArea).not.toContainElement(workspaceTab);
      expect(scrollArea).not.toContainElement(harnessTab);

      fireEvent.click(harnessTab);
      expect(screen.getByTestId('harness-section')).toBeInTheDocument();
      expect(scrollArea).toContainElement(screen.getByTestId('harness-section'));

      fireEvent.click(workspaceTab);
      expect(screen.getByTestId('workspace-section')).toBeInTheDocument();
    });

    it('云电脑移动端 Github 页签展示设置入口，工作负载页签无入口', () => {
      mockIsMobile.mockReturnValue(true);
      mockControllers([
        makeController({ type: 'cloud', cloudHost: makeCloudHost({ status: 'RUNNING' }) }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      fireEvent.click(screen.getByTestId('config-tab-workloads'));
      expect(screen.queryByRole('button', { name: 'Github 项目设置' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('config-tab-github'));
      expect(screen.getByRole('button', { name: 'Github 项目设置' })).toBeInTheDocument();
    });

    it('普通主机移动端同样渲染 2 个 tab 且不展示云电脑面板', () => {
      mockIsMobile.mockReturnValue(true);
      mockControllers([makeController({ type: 'local' })]);

      render(<ControllerConfigPage {...defaultProps} />);

      expect(screen.getByRole('button', { name: '工作区' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Harness 工具' })).toBeInTheDocument();
      expect(screen.queryByTestId('cloud-host-panel')).not.toBeInTheDocument();
    });
  });
});

describe('ControllerConfigPage 默认 MCP 页签', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
  });

  it('切换「默认 MCP」页签挂载 McpDefaultSection', () => {
    mockControllers([makeController()]);

    render(<ControllerConfigPage controllerId="ctrl-1" onBack={vi.fn()} />);

    fireEvent.click(screen.getByTestId('config-tab-mcp'));
    expect(screen.getByTestId('mcp-default-section')).toHaveAttribute('data-controller-id', 'ctrl-1');
  });

  it('移动端「默认 MCP」页签常驻滚动容器外', () => {
    mockIsMobile.mockReturnValue(true);
    mockControllers([makeController()]);

    render(<ControllerConfigPage controllerId="ctrl-1" onBack={vi.fn()} />);

    const scrollArea = screen.getByTestId('mobile-section-scroll');
    const mcpTab = screen.getByTestId('config-tab-mcp');
    expect(scrollArea).not.toContainElement(mcpTab);

    fireEvent.click(mcpTab);
    expect(scrollArea).toContainElement(screen.getByTestId('mcp-default-section'));
  });
});

describe('ControllerConfigPage 工作流页签（T-RW-WEB6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRepoWorkflowPrompted();
    mockIsMobile.mockReturnValue(false);
  });

  it('cloud 主机桌面端渲染 config-tab-workflow 并挂载区块（版本透传）', () => {
    mockControllers([
      makeController({
        type: 'cloud',
        version: '2.18.0',
        cloudHost: makeCloudHost({ status: 'RUNNING' }),
      }),
    ]);

    render(<ControllerConfigPage controllerId="ctrl-1" onBack={vi.fn()} />);

    fireEvent.click(screen.getByTestId('config-tab-workflow'));
    expect(screen.getByTestId('repo-workflow-section')).toHaveAttribute('data-version', '2.18.0');
    expect(screen.getByTestId('repo-workflow-section')).toHaveAttribute('data-controller-id', 'ctrl-1');
  });

  it('cloud 主机移动端渲染 config-tab-workflow，且页签常驻滚动容器外', () => {
    mockIsMobile.mockReturnValue(true);
    mockControllers([
      makeController({ type: 'cloud', cloudHost: makeCloudHost({ status: 'RUNNING' }) }),
    ]);

    render(<ControllerConfigPage controllerId="ctrl-1" onBack={vi.fn()} />);

    const scrollArea = screen.getByTestId('mobile-section-scroll');
    const workflowTab = screen.getByTestId('config-tab-workflow');
    expect(scrollArea).not.toContainElement(workflowTab);

    fireEvent.click(workflowTab);
    expect(scrollArea).toContainElement(screen.getByTestId('repo-workflow-section'));
  });

  it('非 cloud 主机不渲染工作流页签', () => {
    mockControllers([makeController({ type: 'local' })]);

    render(<ControllerConfigPage controllerId="ctrl-1" onBack={vi.fn()} />);

    expect(screen.queryByTestId('config-tab-workflow')).not.toBeInTheDocument();
  });

  it('手工新增工作目录后检测到合法模板 → 弹出提示（同工作区仅一次）', async () => {
    mockControllers([
      makeController({
        type: 'cloud',
        version: '2.18.0',
        cloudHost: makeCloudHost({
          status: 'RUNNING',
          defaultWorkspace: '/home/worker/workspace/project',
        }),
      }),
    ]);
    mockClientQuery.mockResolvedValue({
      data: {
        repoWorkflowTemplates: [
          { fileName: 'dev.json', name: '开发流程', valid: true, errors: [], nodes: [] },
        ],
      },
    });

    render(<ControllerConfigPage controllerId="ctrl-1" onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'mock-workspace-created' }));

    await waitFor(() => {
      expect(screen.getByTestId('repo-workflow-prompt-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'mock-workspace-created' }));
    await waitFor(() => {
      expect(mockClientQuery).toHaveBeenCalledTimes(1);
    });
  });

  it('GitHub 项目设置成功 → 按 defaultWorkspace 定位工作区并检测提示', async () => {
    mockControllers([
      makeController({
        type: 'cloud',
        version: '2.18.0',
        cloudHost: makeCloudHost({
          status: 'RUNNING',
          defaultWorkspace: '/home/worker/workspace/project',
        }),
      }),
    ]);
    mockClientQuery
      .mockResolvedValueOnce({
        data: {
          controllerWorkspaces: [
            { id: 'ws-default', path: '/home/worker/workspace/project' },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          repoWorkflowTemplates: [
            { fileName: 'dev.json', name: '开发流程', valid: true, errors: [], nodes: [] },
          ],
        },
      });

    render(<ControllerConfigPage controllerId="ctrl-1" onBack={vi.fn()} />);

    fireEvent.click(screen.getByTestId('config-tab-github'));
    fireEvent.click(screen.getByRole('button', { name: 'Github 项目设置' }));
    fireEvent.click(screen.getByRole('button', { name: 'mock-github-finished' }));

    await waitFor(() => {
      expect(screen.getByTestId('repo-workflow-prompt-dialog')).toBeInTheDocument();
    });
  });
});

describe('ControllerConfigPage 工作组件版本区块（T-UPG-W）', () => {
  const props = { controllerId: 'ctrl-1', onBack: vi.fn() };

  function renderWithHost(host: CloudHostData) {
    mockControllers([makeController({ type: 'cloud', cloudHost: host })]);
    return render(<ControllerConfigPage {...props} />);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
    mockMutate.mockReset();
    mockClientQuery.mockReset();
  });

  it('T-UPG-W1: 版本区块三态渲染与自动升级周期小字', () => {
    const { unmount } = renderWithHost(
      makeCloudHost({
        agentGearVersion: {
          currentVersion: '2.20.0',
          latestVersion: '2.20.0',
          upgradeAvailable: false,
          autoUpdateIntervalMinutes: 10,
        },
      }),
    );
    const block = screen.getByTestId('cloud-host-agent-gear-version');
    expect(block).toHaveTextContent('当前版本 2.20.0');
    expect(block).toHaveTextContent('最新版本 2.20.0');
    expect(block).toHaveTextContent('自动升级每 10 分钟检查一次');
    expect(screen.queryByRole('button', { name: '立即升级' })).not.toBeInTheDocument();
    unmount();

    renderWithHost(
      makeCloudHost({
        agentGearVersion: {
          currentVersion: '2.19.0',
          latestVersion: '2.20.0',
          upgradeAvailable: true,
          autoUpdateIntervalMinutes: 5,
        },
      }),
    );
    expect(screen.getByRole('button', { name: '立即升级' })).toBeInTheDocument();
    expect(screen.getByTestId('cloud-host-agent-gear-version')).toHaveTextContent(
      '自动升级每 5 分钟检查一次',
    );
  });

  it('T-UPG-W1b: 版本字段缺失展示 —、无按钮、周期回退默认 10', () => {
    renderWithHost(makeCloudHost());
    const block = screen.getByTestId('cloud-host-agent-gear-version');
    expect(block).toHaveTextContent('当前版本 —');
    expect(block).toHaveTextContent('最新版本 —');
    expect(block).toHaveTextContent('自动升级每 10 分钟检查一次');
    expect(screen.queryByRole('button', { name: '立即升级' })).not.toBeInTheDocument();
  });

  it('T-UPG-W2: 按钮可见性门（非 RUNNING / 已软删 / upgradeAvailable=false 均不渲染）', () => {
    const available = {
      currentVersion: '2.19.0',
      latestVersion: '2.20.0',
      upgradeAvailable: true,
      autoUpdateIntervalMinutes: 10,
    };
    for (const overrides of [
      { status: 'STARTING' as const, agentGearVersion: available },
      { status: 'STOPPED' as const, agentGearVersion: available },
      { status: 'RUNNING' as const, deletedAt: '2026-01-01T00:00:00Z', agentGearVersion: available },
      {
        status: 'RUNNING' as const,
        agentGearVersion: { ...available, upgradeAvailable: false },
      },
    ]) {
      const { unmount } = renderWithHost(makeCloudHost(overrides));
      expect(screen.queryByRole('button', { name: '立即升级' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('T-UPG-W3: 点击立即升级携带 controllerId、进入升级中态、轮询收敛 toast', async () => {
    let resolveMutation: ((value: unknown) => void) | undefined;
    mockMutate.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    mockClientQuery.mockResolvedValue({
      data: {
        cloudHost: {
          agentGearVersion: {
            currentVersion: '2.21.0',
            latestVersion: '2.21.0',
            upgradeAvailable: false,
            autoUpdateIntervalMinutes: 10,
          },
        },
      },
    });
    renderWithHost(
      makeCloudHost({
        agentGearVersion: {
          currentVersion: '2.20.0',
          latestVersion: '2.21.0',
          upgradeAvailable: true,
          autoUpdateIntervalMinutes: 10,
        },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '立即升级' }));
    await waitFor(() =>
      expect(mockMutate).toHaveBeenCalledWith({ variables: { controllerId: 'ctrl-1' } }),
    );
    expect(screen.getByRole('button', { name: /升级中/ })).toBeDisabled();

    resolveMutation?.({ data: { upgradeCloudHostAgentGear: { accepted: true } } });
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('工作组件已升级到 2.21.0'),
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { id: 'cloud-1' },
        fetchPolicy: 'network-only',
      }),
    );
  });

  it('T-UPG-W4: 轮询 3 分钟超时 toast；卸载清理定时器', async () => {
    vi.useFakeTimers();
    try {
      mockMutate.mockResolvedValue({ data: { upgradeCloudHostAgentGear: { accepted: true } } });
      mockClientQuery.mockResolvedValue({
        data: {
          cloudHost: {
            agentGearVersion: {
              currentVersion: '2.20.0',
              latestVersion: '2.21.0',
              upgradeAvailable: true,
              autoUpdateIntervalMinutes: 10,
            },
          },
        },
      });
      const { unmount } = renderWithHost(
        makeCloudHost({
          agentGearVersion: {
            currentVersion: '2.20.0',
            latestVersion: '2.21.0',
            upgradeAvailable: true,
            autoUpdateIntervalMinutes: 10,
          },
        }),
      );

      fireEvent.click(screen.getByRole('button', { name: '立即升级' }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 2000);
      expect(mockToastError).toHaveBeenCalledWith('升级超时，可重试或等待自动升级');

      const callsBeforeUnmount = mockClientQuery.mock.calls.length;
      unmount();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockClientQuery.mock.calls.length).toBe(callsBeforeUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T-UPG-W5: mutation 失败经 lib 映射为中文 toast，按钮恢复可重试', async () => {
    mockMutate.mockRejectedValue(new Error('container is not online'));
    renderWithHost(
      makeCloudHost({
        agentGearVersion: {
          currentVersion: '2.20.0',
          latestVersion: '2.21.0',
          upgradeAvailable: true,
          autoUpdateIntervalMinutes: 10,
        },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '立即升级' }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('云电脑未在线，请稍后重试或等待自动升级'),
    );
    expect(screen.getByRole('button', { name: '立即升级' })).toBeEnabled();
  });
});
