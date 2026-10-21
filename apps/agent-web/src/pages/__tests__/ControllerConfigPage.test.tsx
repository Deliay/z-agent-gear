import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ControllerConfigPage from '../ControllerConfigPage';
import type { CloudHostData, ControllerData } from '@/graphql/types';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('@/components/settings/WorkspaceSection', () => ({
  default: () => <div data-testid="workspace-section">WorkspaceSection</div>,
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

vi.mock('@/components/cloud-host/GithubProjectSetupDialog', () => ({
  default: ({ open, controllerId, cloudHost }: {
    open: boolean;
    controllerId: string;
    cloudHost: CloudHostData;
  }) => open ? (
    <div data-testid="github-setup-dialog" data-controller-id={controllerId}>
      {cloudHost.name}
    </div>
  ) : null,
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

    it('T-AW-G1/G12 云电脑展示工作负载页签与 Github 入口', () => {
      mockControllers([
        makeController({ type: 'cloud', cloudHost: makeCloudHost({ status: 'RUNNING' }) }),
      ]);

      render(<ControllerConfigPage {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: '工作负载' }));
      expect(screen.getByTestId('cloud-host-workloads-section')).toHaveAttribute('data-controller-id', 'ctrl-1');

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

      fireEvent.click(screen.getByRole('button', { name: '工作负载' }));
      expect(screen.getByRole('button', { name: 'Github 项目设置' })).toBeDisabled();
    });

    it('普通主机不展示工作负载页签与 Github 入口', () => {
      mockControllers([makeController({ type: 'local' })]);

      render(<ControllerConfigPage {...defaultProps} />);

      expect(screen.queryByRole('button', { name: '工作负载' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Github 项目设置' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('cloud-host-workloads-section')).not.toBeInTheDocument();
    });
  });
});
