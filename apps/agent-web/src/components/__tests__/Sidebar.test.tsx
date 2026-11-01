import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Sidebar from '../Sidebar';
import { logger } from '../../lib/logger';
import type { CloudHostData, HomeOverviewData, HomeOverviewControllerData, HomeOverviewWorkspaceData, SessionData } from '../../graphql/types';
import type { WorkflowInstanceSummaryData } from '../../graphql/workflow';

const mockUseMutation = vi.fn();
const mockUseQuery = vi.fn();
const mockUseHomeOverview = vi.fn();
const mockNavigate = vi.fn();
const mockRefetch = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockUseMutation],
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useApolloClient: () => ({ resetStore: vi.fn() }),
}));

vi.mock('../../stores/homeOverview', () => ({
  useHomeOverview: () => mockUseHomeOverview(),
}));

vi.mock('react-router-dom', () => ({
  NavLink: ({ children, to, className }: { children: React.ReactNode; to: string; className?: string | ((state: { isActive: boolean; isPending: boolean }) => string) }) => (
    <a href={to} className={typeof className === 'function' ? className({ isActive: false, isPending: false }) : className}>
      {children}
    </a>
  ),
  useParams: () => ({}),
  useNavigate: () => mockNavigate,
}));

const newSessionDialogProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../session/NewSessionDialog', () => ({
  default: (props: Record<string, unknown>) => {
    newSessionDialogProps.current = props;
    return <div data-testid="new-session-dialog" />;
  },
}));

vi.mock('../cloud-host/NewCloudHostDialog', () => ({
  default: ({ open, onCreated, onClose }: {
    open: boolean;
    onCreated: (cloudHost: CloudHostData) => void;
    onClose: () => void;
  }) => open ? (
    <div data-testid="new-cloud-host-dialog">
      <button
        type="button"
        onClick={() => onCreated({
          id: 'cloud-host-new',
          name: '新云电脑',
          controllerId: 'ctrl-cloud-new',
          status: 'STARTING',
          harnessTypes: ['OPENCODE'],
          defaultSessionId: null,
          activeSessionCount: 0,
          failureReason: null,
          deletedAt: null,
        })}
      >
        提交云电脑
      </button>
      <button type="button" onClick={onClose}>关闭云电脑对话框</button>
    </div>
  ) : null,
}));

vi.mock('../cloud-host/GithubProjectSetupDialog', () => ({
  default: ({ open, controllerId, cloudHost, onClose }: {
    open: boolean;
    controllerId: string;
    cloudHost: CloudHostData;
    onClose: () => void;
  }) => open ? (
    <div data-testid="github-setup-dialog" data-controller-id={controllerId}>
      <span>{cloudHost.name}</span>
      <span data-testid="github-setup-host-default-workspace">{cloudHost.defaultWorkspace}</span>
      <button type="button" onClick={onClose}>关闭 Github 对话框</button>
    </div>
  ) : null,
}));

vi.mock('../workflow/InstantiateWorkflowDialog', () => ({
  default: ({ open }: { open: boolean }) => open ? <div data-testid="instantiate-workflow-dialog" /> : null,
}));

vi.mock('../TodoListPanel', () => ({
  TodoListPanel: () => <div data-testid="todo-list-panel" />,
}));

vi.mock('../ThemeToggle', () => ({
  default: () => <div data-testid="theme-toggle" />,
}));

vi.mock('../GatewayDialog', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="gateway-dialog">
      <button onClick={onClose}>关闭</button>
    </div>
  ),
}));

vi.mock('../GatewayItem', () => ({
  default: ({ gateway }: { gateway: { name: string } }) => (
    <li data-testid="gateway-item">{gateway.name}</li>
  ),
}));

function makeController(overrides: Partial<HomeOverviewControllerData> = {}): HomeOverviewControllerData {
  return {
    id: 'ctrl-1',
    name: '测试控制器',
    hostname: 'localhost',
    type: 'local',
    status: 'online',
    keyId: 'key-1',
    version: '1.0.0',
    lastHeartbeatAt: null,
    createdAt: '',
    updatedAt: '',
    gateways: { gateways: [], total: 0, limit: 0 },
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<HomeOverviewWorkspaceData> = {}): HomeOverviewWorkspaceData {
  return {
    id: 'ws-1',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    name: 'project',
    path: '/home/user/project',
    isEnabled: true,
    isGitRepo: false,
    createdAt: '',
    updatedAt: '',
    worktrees: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'session-1',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    controllerName: '测试控制器',
    acpServerType: 'opencode',
    status: 'active',
    title: '会话',
    externalSessionId: null,
    cwd: null,
    worktreePath: null,
    worktreeBranch: null,
    createdAt: '',
    updatedAt: '',
    endedAt: null,
    ...overrides,
  };
}

function makeInstance(overrides: Partial<WorkflowInstanceSummaryData> = {}): WorkflowInstanceSummaryData {  return {
    id: 'inst-1',
    configuredWorkflowId: null,
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: '需求A开发',
    currentNodeNames: [],
    lastNodeName: null,
    lastNodeStatus: null,
    archived: false,
    workspace: { id: 'ws-1', name: 'project' },
    controller: { id: 'ctrl-1', name: '测试控制器' },
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function makeCloudHost(overrides: Partial<CloudHostData> = {}): CloudHostData {
  return {
    id: 'cloud-host-1',
    name: '云电脑',
    controllerId: 'ctrl-1',
    status: 'RUNNING',
    harnessTypes: ['OPENCODE'],
    defaultSessionId: null,
    activeSessionCount: 0,
    failureReason: null,
    deletedAt: null,
    hasDefaultWorkspace: true,
    ...overrides,
  };
}

/** 默认空数据；测试通过 mockHome 覆盖 */
function mockHome(overrides: Partial<HomeOverviewData> = {}) {
  const data: HomeOverviewData = {
    controllers: [makeController()],
    sessions: [],
    sessionTotalCount: 0,
    workspaces: [],
    workflowInstances: [],
    archivedWorkflowInstances: [],
    todos: [],
    unreadTodoCount: 0,
    ...overrides,
  };
  mockUseHomeOverview.mockReturnValue({ data, loading: false, error: undefined, refetch: mockRefetch });
  return data;
}

function mockCapabilities(enabled = true, supportedHarnesses: CloudHostData['harnessTypes'] = ['OPENCODE']) {
  mockUseQuery.mockReturnValue({
    data: { cloudHostCapabilities: { enabled, supportedHarnesses } },
    loading: false,
  });
}

describe('Sidebar 集成测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCapabilities();
    mockHome();
  });

  it('U-5: Sidebar 的新建会话回调 9 参映射到 CreateSessionInput', async () => {
    mockHome({
      workspaces: [makeWorkspace()],
    });
    render(<Sidebar name="testuser" />);

    const newSessionButtons = screen.getAllByLabelText('新建会话');
    fireEvent.click(newSessionButtons[0]);

    const props = newSessionDialogProps.current as {
      onCreate: (...args: unknown[]) => Promise<void>;
    };
    expect(props).toBeTruthy();
    mockUseMutation.mockResolvedValue({ data: { createSession: { session: { id: 'sess-new' } } } });

    await props.onCreate(
      'ctrl-1',
      'opencode',
      'ws-1',
      false,
      'feat-x',
      ['mcp-1'],
      '/repo/.worktrees/feat-a',
      'mode-1',
      'model-1',
    );

    expect(mockUseMutation).toHaveBeenCalledWith({
      variables: {
        input: expect.objectContaining({
          modeId: 'mode-1',
          modelId: 'model-1',
          existingWorktreePath: '/repo/.worktrees/feat-a',
        }),
      },
      refetchQueries: expect.any(Array),
    });
  });

  describe('① 四个平级分组渲染', () => {
    it('展开控制器后渲染统一网关、工作流、会话、工作区四个分组', () => {
      render(<Sidebar name="testuser" />);

      expect(screen.getByText('统一网关')).toBeInTheDocument();
      expect(screen.getByText('工作流')).toBeInTheDocument();
      expect(screen.getByText('会话')).toBeInTheDocument();
      expect(screen.getByText('工作区')).toBeInTheDocument();
    });
  });

  describe('② 网关 Plus 打开 GatewayDialog', () => {
    it('无网关时点击 Plus 按钮打开 GatewayDialog 且弹窗不在 hidden 容器内', () => {
      render(<Sidebar name="testuser" />);

      fireEvent.click(screen.getByTitle('新增网关'));

      const dialog = screen.getByTestId('gateway-dialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog.closest('.hidden')).toBeNull();
    });

    it('显示下传的网关列表（纯展示）', () => {
      mockHome({
        controllers: [
          makeController({
            gateways: {
              gateways: [{ id: 'gw-1', controllerId: 'ctrl-1', name: 'my-api', port: 3000, status: 'active', createdAt: '' }],
              total: 1,
              limit: 10,
            },
          }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getByText('my-api')).toBeInTheDocument();
    });
  });

  describe('③ 会话 cwd 最长前缀匹配', () => {
    it('显示最深匹配的工作区名', () => {
      mockHome({
        sessions: [makeSession({ id: 'session-1', title: '深层会话', cwd: '/home/user/project/sub/deep' })],
        workspaces: [
          makeWorkspace({ id: 'ws-1', name: 'project', path: '/home/user/project' }),
          makeWorkspace({ id: 'ws-2', name: 'project-sub', path: '/home/user/project/sub' }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getByText('深层会话')).toBeInTheDocument();
      expect(screen.getByText('project-sub')).toBeInTheDocument();
    });

    it('不匹配任何工作区时显示未知工作区', () => {
      mockHome({
        sessions: [makeSession({ id: 'session-1', title: '孤立会话', cwd: '/unknown/path' })],
        workspaces: [makeWorkspace({ id: 'ws-1', name: 'project', path: '/home/user' })],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getByText('孤立会话')).toBeInTheDocument();
      expect(screen.getByText('未知工作区')).toBeInTheDocument();
    });
  });

  describe('④ 工作流集中列表', () => {
    it('无工作流实例时显示空态', () => {
      render(<Sidebar name="testuser" />);
      expect(screen.getByText('无工作流实例')).toBeInTheDocument();
    });

    it('集中平铺展示全部实例并标注所属工作区与状态（不按工作区分组）', () => {
      mockHome({
        workspaces: [makeWorkspace({ id: 'ws-1', name: 'project' })],
        workflowInstances: [
          makeInstance({ id: 'inst-1', name: '实例一', workspace: { id: 'ws-1', name: 'project' } }),
          makeInstance({ id: 'inst-2', name: '实例二', workspaceId: 'ws-deleted', workspace: null }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.queryByText('无工作流实例')).not.toBeInTheDocument();
      expect(screen.getByText('实例一')).toBeInTheDocument();
      expect(screen.getByText('实例二')).toBeInTheDocument();
      // 归属工作区/控制器标注（工作区已删除显示「未知工作区」）
      expect(screen.getByText(/^project · 测试控制器 · /)).toBeInTheDocument();
      expect(screen.getByText('未知工作区')).toBeInTheDocument();
      // 点击直达详情
      expect(screen.getByText('实例一').closest('a')?.getAttribute('href')).toBe('/workflows/inst-1');
    });

    it('实例上报后从空态切换为列表', () => {
      const { rerender } = render(<Sidebar name="testuser" />);
      expect(screen.getByText('无工作流实例')).toBeInTheDocument();

      mockHome({ workflowInstances: [makeInstance()] });
      rerender(<Sidebar name="testuser" />);

      expect(screen.queryByText('无工作流实例')).not.toBeInTheDocument();
      expect(screen.getByText('需求A开发')).toBeInTheDocument();
    });
  });

  describe('⑤ 无限渲染循环回归', () => {
    it('render 后正常完成，无 React 报错', () => {
      // React 渲染错误直接走 console.error（框架通道，不经 logger），保留断言以捕获无限渲染循环；
      // 业务错误日志统一在 logger 层断言（logger 是包内唯一 console 出口）。
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      render(<Sidebar name="testuser" />);
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(loggerSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
      loggerSpy.mockRestore();
    });
  });

  describe('⑥ 无会话/无工作区时显示空态文案', () => {
    it('无会话时显示「无会话」', () => {
      render(<Sidebar name="testuser" />);
      expect(screen.getByText('无会话')).toBeInTheDocument();
    });

    it('无工作区时显示「无工作区」', () => {
      render(<Sidebar name="testuser" />);
      expect(screen.getByText('无工作区')).toBeInTheDocument();
    });
  });

  describe('已归档工作流实例折叠', () => {
    it('默认收起，展开后归档实例名称可见', () => {
      mockHome({
        workflowInstances: [makeInstance({ id: 'inst-active', name: '活跃实例' })],
        archivedWorkflowInstances: [makeInstance({ id: 'inst-archived', name: '已归档实例', archived: true })],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.queryByText('已归档实例')).not.toBeInTheDocument();
      expect(screen.getByText('活跃实例')).toBeInTheDocument();
      const archiveButton = screen.getByText(/已归档/);
      expect(archiveButton).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(archiveButton);

      expect(screen.getByText('已归档实例')).toBeInTheDocument();
      expect(archiveButton).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('云电脑体验（Phase 8）', () => {
    it('T-AW1 云电脑显示云图标，普通主机不显示', () => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-cloud', type: 'cloud', cloudHost: makeCloudHost() }),
          makeController({ id: 'ctrl-local', type: 'local' }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getAllByTestId('cloud-host-icon')).toHaveLength(1);
    });

    it.each([
      ['STARTING', '启动中'],
      ['RUNNING', '运行中'],
      ['STOPPING', '停止中'],
      ['STOPPED', '已销毁'],
      ['FAILED', '失败'],
    ] as const)('T-AW6 %s 映射为「%s」且已销毁仍可进入', (status, label) => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-cloud', type: 'cloud', cloudHost: makeCloudHost({ status }) }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getByTestId('cloud-host-status')).toHaveTextContent(label);
      fireEvent.click(screen.getByTitle('控制器配置'));
      expect(mockNavigate).toHaveBeenCalledWith('/settings?controllerId=ctrl-cloud');
    });

    it('FAILED 状态展示失败原因', () => {
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({ status: 'FAILED', failureReason: 'container exited' }),
          }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getByTestId('cloud-host-status')).toHaveTextContent('失败 · container exited');
    });

    it('T-AW2 capabilities.enabled=false 时隐藏新建云电脑入口', () => {
      mockCapabilities(false, []);
      render(<Sidebar name="testuser" />);

      expect(screen.queryByLabelText('新建云电脑')).not.toBeInTheDocument();
    });

    it('T-AW2 无活跃云电脑时显示新建入口并可打开对话框', () => {
      render(<Sidebar name="testuser" />);

      const entry = screen.getByLabelText('新建云电脑');
      expect(entry).not.toBeDisabled();
      fireEvent.click(entry);

      expect(screen.getByTestId('new-cloud-host-dialog')).toBeInTheDocument();
    });

    it('T-AW2 已有 RUNNING 云电脑时入口仍可点击并打开对话框', () => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-cloud', type: 'cloud', cloudHost: makeCloudHost({ status: 'RUNNING' }) }),
        ],
      });

      render(<Sidebar name="testuser" />);

      const entry = screen.getByLabelText('新建云电脑');
      expect(entry).not.toBeDisabled();
      expect(entry).toHaveAttribute('title', '新建云电脑');
      fireEvent.click(entry);
      expect(screen.getByTestId('new-cloud-host-dialog')).toBeInTheDocument();
    });

    it.each(['STARTING', 'STOPPING'] as const)('%s 状态不再禁用新建入口', (status) => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-cloud', type: 'cloud', cloudHost: makeCloudHost({ status }) }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getByLabelText('新建云电脑')).not.toBeDisabled();
    });

    it('T-AW4 新建成功后 refetch HOME_OVERVIEW 并进入主机配置页', () => {
      render(<Sidebar name="testuser" />);

      fireEvent.click(screen.getByLabelText('新建云电脑'));
      fireEvent.click(screen.getByText('提交云电脑'));

      expect(mockRefetch).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/settings?controllerId=ctrl-cloud-new');
      expect(screen.queryByTestId('new-cloud-host-dialog')).not.toBeInTheDocument();
    });

    it('T-AW14 mobile Sidebar 同样可达新建云电脑入口', () => {
      render(<Sidebar name="testuser" mobile />);

      expect(screen.getByLabelText('新建云电脑')).toBeInTheDocument();
    });

    it('已销毁条目置灰但仍可进入', () => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-cloud', type: 'cloud', cloudHost: makeCloudHost({ status: 'STOPPED' }) }),
        ],
      });

      render(<Sidebar name="testuser" />);

      const row = screen.getByTestId('cloud-host-status').closest('button');
      expect(row).toHaveClass('opacity-50');
      expect(screen.getByTitle('控制器配置')).toBeInTheDocument();
    });

    it('D-2 RUNNING 且单一 Harness 但无默认会话时提示可手动创建会话', () => {
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({ status: 'RUNNING', defaultSessionId: null }),
          }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getByTestId('cloud-host-default-session-hint')).toHaveTextContent(
        '默认会话创建失败，可手动创建会话',
      );
    });

    it('D-2 默认会话已创建或多 Harness 时不展示失败提示', () => {
      const { rerender } = render(<Sidebar name="testuser" />);
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({ status: 'RUNNING', defaultSessionId: 'sess-1' }),
          }),
        ],
      });
      rerender(<Sidebar name="testuser" />);
      expect(screen.queryByTestId('cloud-host-default-session-hint')).not.toBeInTheDocument();

      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({
              status: 'RUNNING',
              defaultSessionId: null,
              harnessTypes: ['OPENCODE', 'CLAUDE_CODE'] as CloudHostData['harnessTypes'],
            }),
          }),
        ],
      });
      rerender(<Sidebar name="testuser" />);
      expect(screen.queryByTestId('cloud-host-default-session-hint')).not.toBeInTheDocument();
    });

    it('无默认工作区的 RUNNING 云电脑展示无工作区提示且不展示默认会话失败', () => {
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({
              status: 'RUNNING',
              defaultSessionId: null,
              hasDefaultWorkspace: false,
            }),
          }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getByTestId('cloud-host-no-workspace-hint')).toHaveTextContent(
        '未创建默认工作区，请先创建或绑定工作区',
      );
      expect(screen.queryByTestId('cloud-host-default-session-hint')).not.toBeInTheDocument();
    });

    it('无默认工作区但控制器已有工作区时不再展示无工作区提示', () => {
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({
              status: 'RUNNING',
              defaultSessionId: null,
              hasDefaultWorkspace: false,
            }),
          }),
        ],
        workspaces: [
          makeWorkspace({ id: 'ws-1', controllerId: 'ctrl-cloud', name: 'workspace', path: '/root/workspace' }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.queryByTestId('cloud-host-no-workspace-hint')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cloud-host-default-session-hint')).not.toBeInTheDocument();
    });

    it('无默认工作区时展示 Github 入口与新建工作区入口并跳转设置页', () => {
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({ status: 'RUNNING', hasDefaultWorkspace: false }),
          }),
        ],
      });

      const { rerender } = render(<Sidebar name="testuser" />);

      expect(screen.getByLabelText('Github 项目设置')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('新建工作区'));
      expect(mockNavigate).toHaveBeenCalledWith('/settings?controllerId=ctrl-cloud');

      // 有工作区时不展示「新建工作区」入口（避免与已建工作区语义冲突）
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({ status: 'RUNNING', hasDefaultWorkspace: true }),
          }),
        ],
      });
      rerender(<Sidebar name="testuser" />);
      expect(screen.queryByLabelText('新建工作区')).not.toBeInTheDocument();
    });

    it('多 Harness 且无默认会话时不展示任何失败/无工作区提示', () => {
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({
              status: 'RUNNING',
              defaultSessionId: null,
              harnessTypes: ['OPENCODE', 'CLAUDE_CODE'] as CloudHostData['harnessTypes'],
            }),
          }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.queryByTestId('cloud-host-no-workspace-hint')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cloud-host-default-session-hint')).not.toBeInTheDocument();
    });

    it('云电脑未运行时禁用新建会话入口并提示', () => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-cloud', type: 'cloud', cloudHost: makeCloudHost({ status: 'STOPPED' }) }),
        ],
      });

      render(<Sidebar name="testuser" />);

      const buttons = screen.getAllByLabelText('新建会话');
      const sectionButton = buttons.find((button) => button.getAttribute('title') === '云电脑未运行，无法创建会话');
      expect(sectionButton).toBeDefined();
      expect(sectionButton).toBeDisabled();
    });

    it('T-AW-G1 仅 RUNNING 云电脑的工作区展示 Github 入口，local/STOPPED 不展示', () => {
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({ defaultWorkspace: '/root/workspace' }),
          }),
          makeController({ id: 'ctrl-local', type: 'local' }),
          makeController({
            id: 'ctrl-stopped',
            type: 'cloud',
            cloudHost: makeCloudHost({ id: 'cloud-stopped', status: 'STOPPED' }),
          }),
        ],
      });

      render(<Sidebar name="testuser" />);

      expect(screen.getAllByLabelText('Github 项目设置')).toHaveLength(1);
    });

    it('T-AW-G2 点击 Github 入口打开设置弹窗并固定当前云电脑', () => {
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-cloud',
            type: 'cloud',
            cloudHost: makeCloudHost({ defaultWorkspace: '/root/workspace' }),
          }),
        ],
      });

      render(<Sidebar name="testuser" />);

      fireEvent.click(screen.getByLabelText('Github 项目设置'));

      const dialog = screen.getByTestId('github-setup-dialog');
      expect(dialog).toHaveAttribute('data-controller-id', 'ctrl-cloud');
      expect(screen.getByTestId('github-setup-host-default-workspace')).toHaveTextContent('/root/workspace');
    });

    it('T-AW-G1 mobile Sidebar 同样可达 Github 入口', () => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-cloud', type: 'cloud', cloudHost: makeCloudHost() }),
        ],
      });

      render(<Sidebar name="testuser" mobile />);

      expect(screen.getByLabelText('Github 项目设置')).toBeInTheDocument();
    });
  });
});
