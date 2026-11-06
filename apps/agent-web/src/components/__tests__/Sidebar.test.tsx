import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import Sidebar from '../Sidebar';
import { SIDEBAR_SECTIONS_KEY } from '../../lib/sidebar-prefs';
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
  NavLink: ({ children, to, className, title }: { children: React.ReactNode; to: string; className?: string | ((state: { isActive: boolean; isPending: boolean }) => string); title?: string }) => (
    <a href={to} title={title} className={typeof className === 'function' ? className({ isActive: false, isPending: false }) : className}>
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
    archived: false,
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
    archivedSessions: [],
    workspaces: [],
    workflowInstances: [],
    archivedWorkflowInstances: [],
    todos: [],
    unreadTodoCount: 0,
    sessionReviews: [],
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

/** 渲染侧边栏并展开「主机」分区（分区默认折叠，符合 PRD 功能点 1） */
function renderSidebar(props: { mobile?: boolean } = {}) {
  const result = render(<Sidebar name="testuser" {...props} />);
  const hostsToggle = screen.getByRole('button', { name: '主机' });
  if (hostsToggle.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(hostsToggle);
  }
  return result;
}

describe('Sidebar 集成测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.className = '';
    mockCapabilities();
    mockHome();
  });

  it('U-5: Sidebar 的新建会话回调 9 参映射到 CreateSessionInput', async () => {
    mockHome({
      workspaces: [makeWorkspace()],
    });
    renderSidebar();

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
    it('渲染主机、工作流、会话、网关四个分区，且主机分区内保留工作区分组', () => {
      renderSidebar();

      for (const title of ['主机', '工作流', '会话', '网关']) {
        expect(screen.getByTestId(`sidebar-section-${title === '主机' ? 'hosts' : title === '工作流' ? 'workflows' : title === '会话' ? 'sessions' : 'gateways'}`)).toBeInTheDocument();
      }
      expect(screen.getByText('工作区')).toBeInTheDocument();
    });
  });

  describe('② 网关 Plus 打开 GatewayDialog', () => {
    it('聚合分区点击「新增网关」选择主机后打开 GatewayDialog 且弹窗不在 hidden 容器内', () => {
      renderSidebar();

      fireEvent.click(screen.getByRole('button', { name: '新增网关' }));
      fireEvent.click(screen.getByRole('menuitem', { name: '测试控制器' }));

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

      renderSidebar();
      fireEvent.click(screen.getByRole('button', { name: '网关' }));

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

      renderSidebar();

      expect(screen.getByText('深层会话')).toBeInTheDocument();
      expect(screen.getByText('project-sub')).toBeInTheDocument();
    });

    it('不匹配任何工作区时显示未知工作区', () => {
      mockHome({
        sessions: [makeSession({ id: 'session-1', title: '孤立会话', cwd: '/unknown/path' })],
        workspaces: [makeWorkspace({ id: 'ws-1', name: 'project', path: '/home/user' })],
      });

      renderSidebar();

      expect(screen.getByText('孤立会话')).toBeInTheDocument();
      expect(screen.getByText('未知工作区')).toBeInTheDocument();
    });
  });

  describe('④ 工作流集中列表', () => {
    it('无工作流实例时空态收敛（不渲染占位文字，列表为空）', () => {
      renderSidebar();
      expect(screen.queryByText('无工作流实例')).not.toBeInTheDocument();
      expect(screen.getByTestId('sidebar-workflow-list').children).toHaveLength(0);
    });

    it('集中平铺展示全部实例并标注所属工作区与状态（不按工作区分组）', () => {
      mockHome({
        workspaces: [makeWorkspace({ id: 'ws-1', name: 'project' })],
        workflowInstances: [
          makeInstance({ id: 'inst-1', name: '实例一', workspace: { id: 'ws-1', name: 'project' } }),
          makeInstance({ id: 'inst-2', name: '实例二', workspaceId: 'ws-deleted', workspace: null }),
        ],
      });

      renderSidebar();

      expect(screen.queryByText('无工作流实例')).not.toBeInTheDocument();
      expect(screen.getByText('实例一')).toBeInTheDocument();
      expect(screen.getByText('实例二')).toBeInTheDocument();
      // 两行卡片：第二行工作区名称（工作区已删除显示「未知工作区」），控制器名不再占卡片行
      const cards = screen.getAllByTestId('workflow-instance-card');
      expect(cards[0]).toHaveTextContent('project');
      expect(cards[0]).not.toHaveTextContent('测试控制器');
      expect(screen.getByText('未知工作区')).toBeInTheDocument();
      // 点击直达详情
      expect(screen.getByText('实例一').closest('a')?.getAttribute('href')).toBe('/workflows/inst-1');
    });

    it('实例上报后从空态切换为列表', () => {
      const { rerender } = renderSidebar();
      expect(screen.getByTestId('sidebar-workflow-list').children).toHaveLength(0);

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
      renderSidebar();
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(loggerSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
      loggerSpy.mockRestore();
    });
  });

  describe('⑥ 空态收敛（不再渲染占位文字）', () => {
    it('无会话时不显示「无会话」，会话列表为空', () => {
      renderSidebar();
      expect(screen.queryByText('无会话')).not.toBeInTheDocument();
      expect(screen.getByTestId('sidebar-session-list').children).toHaveLength(0);
    });

    it('无工作区时不显示「无工作区」，工作区分组仍可展开为空', () => {
      renderSidebar();
      expect(screen.queryByText('无工作区')).not.toBeInTheDocument();
      expect(screen.getByText('工作区')).toBeInTheDocument();
    });
  });

  describe('已归档工作流实例折叠', () => {
    it('默认收起，展开后归档实例名称可见', () => {
      mockHome({
        workflowInstances: [makeInstance({ id: 'inst-active', name: '活跃实例' })],
        archivedWorkflowInstances: [makeInstance({ id: 'inst-archived', name: '已归档实例', archived: true })],
      });

      renderSidebar();

      expect(screen.queryByText('已归档实例')).not.toBeInTheDocument();
      expect(screen.getByText('活跃实例')).toBeInTheDocument();
      const archiveButton = screen.getByText(/已归档/);
      expect(archiveButton).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(archiveButton);

      expect(screen.getByText('已归档实例')).toBeInTheDocument();
      expect(archiveButton).toHaveAttribute('aria-expanded', 'true');
    });
  });


  describe('UI 四期：四折叠分区与跨环境聚合', () => {
    it('T-UI4-SEC1 默认展开「工作流」「会话」，折叠「主机」「网关」', () => {
      render(<Sidebar name="testuser" />);

      expect(screen.getByRole('button', { name: '工作流' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: '会话' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: '主机' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('button', { name: '网关' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('T-UI4-SEC2 点击标题行切换展开态并持久化', () => {
      render(<Sidebar name="testuser" />);

      fireEvent.click(screen.getByRole('button', { name: '主机' }));
      expect(screen.getByRole('button', { name: '主机' })).toHaveAttribute('aria-expanded', 'true');
      expect(JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_KEY)!).hosts).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: '工作流' }));
      expect(screen.getByRole('button', { name: '工作流' })).toHaveAttribute('aria-expanded', 'false');
      expect(JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_KEY)!).workflows).toBe(false);
    });

    it('T-UI4-SEC3 刷新（重新挂载）后保持展开态', () => {
      const first = render(<Sidebar name="testuser" />);
      fireEvent.click(screen.getByRole('button', { name: '网关' }));
      first.unmount();

      render(<Sidebar name="testuser" />);
      expect(screen.getByRole('button', { name: '网关' })).toHaveAttribute('aria-expanded', 'true');
    });

    it('T-UI4-SEC4 折叠分区的标题与 actions 保留，内容不渲染', () => {
      render(<Sidebar name="testuser" />);

      expect(screen.queryByTestId('sidebar-section-content-hosts')).not.toBeInTheDocument();
      expect(screen.queryByTestId('sidebar-section-content-gateways')).not.toBeInTheDocument();
      expect(screen.getByTestId('sidebar-section-content-sessions')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: '新建会话' }).length).toBeGreaterThan(0);
    });

    it('T-UI4-AGG1 两个主机的会话聚合在同一列表且点击行为不变', () => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-1', name: '主机一' }),
          makeController({ id: 'ctrl-2', name: '主机二', hostname: '主机二' }),
        ],
        sessions: [
          makeSession({ id: 's1', controllerId: 'ctrl-1', title: '会话一', updatedAt: '2026-01-01T00:00:00Z' }),
          makeSession({
            id: 's2',
            controllerId: 'ctrl-2',
            controllerName: '主机二',
            title: '会话二',
            updatedAt: '2026-01-02T00:00:00Z',
          }),
        ],
      });
      render(<Sidebar name="testuser" />);

      const list = screen.getByTestId('sidebar-session-list');
      expect(within(list).getByText('会话一')).toBeInTheDocument();
      expect(within(list).getByText('会话二')).toBeInTheDocument();
      expect(within(list).getByText('会话二').closest('a')).toHaveAttribute('href', '/sessions/s2');
      // 条目 tooltip 带所属主机名
      expect(within(list).getByText('会话二').closest('a')?.getAttribute('title')).toContain('主机二');
    });

    it('T-UI4-AGG2 两个主机的工作流聚合在同一列表（含已归档分组）', () => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-1', name: '主机一' }),
          makeController({ id: 'ctrl-2', name: '主机二', hostname: '主机二' }),
        ],
        workflowInstances: [
          makeInstance({ id: 'w1', controllerId: 'ctrl-1', name: '主机一实例' }),
          makeInstance({ id: 'w2', controllerId: 'ctrl-2', name: '主机二实例' }),
        ],
        archivedWorkflowInstances: [makeInstance({ id: 'w3', name: '归档实例', archived: true })],
      });
      render(<Sidebar name="testuser" />);

      const list = screen.getByTestId('sidebar-workflow-list');
      expect(within(list).getByText('主机一实例')).toBeInTheDocument();
      expect(within(list).getByText('主机二实例')).toBeInTheDocument();
      expect(within(list).getByText(/已归档（1）/)).toBeInTheDocument();
    });

    it('T-UI4-AGG3 排序稳定：updatedAt 倒序 + id tie-break（轮询不跳动）', () => {
      mockHome({
        sessions: [
          makeSession({ id: 'b', title: 'B', updatedAt: '2026-01-01T00:00:00Z' }),
          makeSession({ id: 'a', title: 'A', updatedAt: '2026-01-01T00:00:00Z' }),
          makeSession({ id: 'c', title: 'C', updatedAt: '2026-01-03T00:00:00Z' }),
        ],
      });
      render(<Sidebar name="testuser" />);

      const links = within(screen.getByTestId('sidebar-session-list')).getAllByRole('link');
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        '/sessions/c',
        '/sessions/a',
        '/sessions/b',
      ]);
    });

    it('T-UI4-AGG4 网关分区聚合在线主机的网关暴露（离线主机不渲染）', () => {
      mockHome({
        controllers: [
          makeController({
            id: 'ctrl-1',
            name: '主机一',
            gateways: {
              gateways: [{ id: 'gw-1', controllerId: 'ctrl-1', name: 'api-one', port: 3000, status: 'active', createdAt: '' }],
              total: 1,
              limit: 10,
            },
          }),
          makeController({
            id: 'ctrl-2',
            name: '主机二',
            gateways: {
              gateways: [{ id: 'gw-2', controllerId: 'ctrl-2', name: 'api-two', port: 3001, status: 'active', createdAt: '' }],
              total: 1,
              limit: 10,
            },
          }),
          makeController({
            id: 'ctrl-offline',
            name: '离线主机',
            status: 'offline',
            hostname: 'offline-host',
            gateways: {
              gateways: [{ id: 'gw-3', controllerId: 'ctrl-offline', name: 'api-offline', port: 3002, status: 'active', createdAt: '' }],
              total: 1,
              limit: 10,
            },
          }),
        ],
      });
      render(<Sidebar name="testuser" />);
      fireEvent.click(screen.getByRole('button', { name: '网关' }));

      const list = screen.getByTestId('sidebar-gateway-list');
      expect(within(list).getByText('api-one')).toBeInTheDocument();
      expect(within(list).getByText('api-two')).toBeInTheDocument();
      // 离线主机网关配置行不上屏（与既有「UI 层按 status 自行隐藏」口径一致）
      expect(within(list).queryByText('api-offline')).not.toBeInTheDocument();
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

      renderSidebar();

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

      renderSidebar();

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

      renderSidebar();

      expect(screen.getByTestId('cloud-host-status')).toHaveTextContent('失败 · container exited');
    });

    it('T-AW2 capabilities.enabled=false 时隐藏新建云电脑入口', () => {
      mockCapabilities(false, []);
      renderSidebar();

      expect(screen.queryByLabelText('新建云电脑')).not.toBeInTheDocument();
    });

    it('T-AW2 无活跃云电脑时显示新建入口并可打开对话框', () => {
      renderSidebar();

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

      renderSidebar();

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

      renderSidebar();

      expect(screen.getByLabelText('新建云电脑')).not.toBeDisabled();
    });

    it('T-AW4 新建成功后 refetch HOME_OVERVIEW 并进入主机配置页', () => {
      renderSidebar();

      fireEvent.click(screen.getByLabelText('新建云电脑'));
      fireEvent.click(screen.getByText('提交云电脑'));

      expect(mockRefetch).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/settings?controllerId=ctrl-cloud-new');
      expect(screen.queryByTestId('new-cloud-host-dialog')).not.toBeInTheDocument();
    });

    it('T-AW14 mobile Sidebar 同样可达新建云电脑入口', () => {
      renderSidebar({ mobile: true });

      expect(screen.getByLabelText('新建云电脑')).toBeInTheDocument();
    });

    it('已销毁条目置灰但仍可进入', () => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-cloud', type: 'cloud', cloudHost: makeCloudHost({ status: 'STOPPED' }) }),
        ],
      });

      renderSidebar();

      const row = screen.getByTestId('cloud-host-status').closest('div');
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

      renderSidebar();

      expect(screen.getByTestId('cloud-host-default-session-hint')).toHaveTextContent(
        '默认会话创建失败，可手动创建会话',
      );
    });

    it('D-2 默认会话已创建或多 Harness 时不展示失败提示', () => {
      const { rerender } = renderSidebar();
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

      renderSidebar();

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

      renderSidebar();

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

      const { rerender } = renderSidebar();

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

      renderSidebar();

      expect(screen.queryByTestId('cloud-host-no-workspace-hint')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cloud-host-default-session-hint')).not.toBeInTheDocument();
    });

    it('云电脑未运行时禁用新建会话入口并提示', () => {
      mockHome({
        controllers: [
          makeController({ id: 'ctrl-cloud', type: 'cloud', cloudHost: makeCloudHost({ status: 'STOPPED' }) }),
        ],
      });

      renderSidebar();

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

      renderSidebar();

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

      renderSidebar();

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

      renderSidebar({ mobile: true });

      expect(screen.getByLabelText('Github 项目设置')).toBeInTheDocument();
    });
  });

  describe('已归档会话分组（T-WEB2）', () => {
    it('T-WEB2 默认折叠、计数正确、活跃列表不含已归档，展开后条目可打开', () => {
      mockHome({
        sessions: [
          makeSession({ id: 's-active', title: '活跃会话', updatedAt: '2026-01-02T00:00:00Z' }),
        ],
        archivedSessions: [
          makeSession({ id: 's-archived', title: '归档会话', archived: true, updatedAt: '2026-01-01T00:00:00Z' }),
        ],
      });

      render(<Sidebar name="testuser" />);

      const groupButton = screen.getByRole('button', { name: /已归档（1）/ });
      expect(groupButton).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('归档会话')).not.toBeInTheDocument();
      expect(screen.getByText('活跃会话')).toBeInTheDocument();

      // 活跃列表链接不含已归档会话（服务端已按未归档过滤，D12）
      const activeLinks = within(screen.getByTestId('sidebar-session-list'))
        .getAllByRole('link')
        .map((link) => link.getAttribute('href'));
      expect(activeLinks).toEqual(['/sessions/s-active']);

      fireEvent.click(groupButton);

      expect(groupButton).toHaveAttribute('aria-expanded', 'true');
      const archivedList = screen.getByTestId('sidebar-archived-session-list');
      const archivedLink = within(archivedList).getByText('归档会话').closest('a');
      expect(archivedLink).toHaveAttribute('href', '/sessions/s-archived');
      // 展开后归档条目仍只出现在归档分组内，不混入活跃列表直接子项
      expect(screen.getByTestId('sidebar-session-list').querySelectorAll(':scope > li')).toHaveLength(2);
    });

    it('T-WEB2 无已归档会话时不渲染分组', () => {
      mockHome({ sessions: [makeSession({ id: 's-active', title: '活跃会话' })] });

      render(<Sidebar name="testuser" />);

      expect(screen.queryByRole('button', { name: /已归档/ })).not.toBeInTheDocument();
      expect(screen.getByText('活跃会话')).toBeInTheDocument();
    });
  });
});
