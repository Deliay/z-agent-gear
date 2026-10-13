import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Sidebar from '../Sidebar';
import type { HomeOverviewData, HomeOverviewControllerData, HomeOverviewWorkspaceData, SessionData } from '../../graphql/types';
import type { WorkflowInstanceSummaryData } from '../../graphql/workflow';

const mockUseMutation = vi.fn();
const mockUseHomeOverview = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockUseMutation],
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
  useNavigate: () => vi.fn(),
}));

vi.mock('../session/NewSessionDialog', () => ({
  default: () => <div data-testid="new-session-dialog" />,
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

function makeInstance(overrides: Partial<WorkflowInstanceSummaryData> = {}): WorkflowInstanceSummaryData {
  return {
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
  mockUseHomeOverview.mockReturnValue({ data, loading: false, error: undefined, refetch: vi.fn() });
  return data;
}

describe('Sidebar 集成测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHome();
  });

  describe('① 四个平级分组渲染', () => {
    it('展开控制器后渲染统一网关、工作流、会话、工作区四个分组', () => {
      render(<Sidebar username="testuser" />);

      expect(screen.getByText('统一网关')).toBeInTheDocument();
      expect(screen.getByText('工作流')).toBeInTheDocument();
      expect(screen.getByText('会话')).toBeInTheDocument();
      expect(screen.getByText('工作区')).toBeInTheDocument();
    });
  });

  describe('② 网关 Plus 打开 GatewayDialog', () => {
    it('无网关时点击 Plus 按钮打开 GatewayDialog 且弹窗不在 hidden 容器内', () => {
      render(<Sidebar username="testuser" />);

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

      render(<Sidebar username="testuser" />);

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

      render(<Sidebar username="testuser" />);

      expect(screen.getByText('深层会话')).toBeInTheDocument();
      expect(screen.getByText('project-sub')).toBeInTheDocument();
    });

    it('不匹配任何工作区时显示未知工作区', () => {
      mockHome({
        sessions: [makeSession({ id: 'session-1', title: '孤立会话', cwd: '/unknown/path' })],
        workspaces: [makeWorkspace({ id: 'ws-1', name: 'project', path: '/home/user' })],
      });

      render(<Sidebar username="testuser" />);

      expect(screen.getByText('孤立会话')).toBeInTheDocument();
      expect(screen.getByText('未知工作区')).toBeInTheDocument();
    });
  });

  describe('④ 工作流集中列表', () => {
    it('无工作流实例时显示空态', () => {
      render(<Sidebar username="testuser" />);
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

      render(<Sidebar username="testuser" />);

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
      const { rerender } = render(<Sidebar username="testuser" />);
      expect(screen.getByText('无工作流实例')).toBeInTheDocument();

      mockHome({ workflowInstances: [makeInstance()] });
      rerender(<Sidebar username="testuser" />);

      expect(screen.queryByText('无工作流实例')).not.toBeInTheDocument();
      expect(screen.getByText('需求A开发')).toBeInTheDocument();
    });
  });

  describe('⑤ 无限渲染循环回归', () => {
    it('render 后正常完成，无 React 报错', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<Sidebar username="testuser" />);
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('⑥ 无会话/无工作区时显示空态文案', () => {
    it('无会话时显示「无会话」', () => {
      render(<Sidebar username="testuser" />);
      expect(screen.getByText('无会话')).toBeInTheDocument();
    });

    it('无工作区时显示「无工作区」', () => {
      render(<Sidebar username="testuser" />);
      expect(screen.getByText('无工作区')).toBeInTheDocument();
    });
  });

  describe('已归档工作流实例折叠', () => {
    it('默认收起，展开后归档实例名称可见', () => {
      mockHome({
        workflowInstances: [makeInstance({ id: 'inst-active', name: '活跃实例' })],
        archivedWorkflowInstances: [makeInstance({ id: 'inst-archived', name: '已归档实例', archived: true })],
      });

      render(<Sidebar username="testuser" />);

      expect(screen.queryByText('已归档实例')).not.toBeInTheDocument();
      expect(screen.getByText('活跃实例')).toBeInTheDocument();
      const archiveButton = screen.getByText(/已归档/);
      expect(archiveButton).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(archiveButton);

      expect(screen.getByText('已归档实例')).toBeInTheDocument();
      expect(archiveButton).toHaveAttribute('aria-expanded', 'true');
    });
  });
});
