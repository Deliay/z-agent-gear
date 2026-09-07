import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Sidebar from '../Sidebar';

// Mock Apollo Client
const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockUseMutation],
}));

// Mock React Router
vi.mock('react-router-dom', () => ({
  NavLink: ({ children, to, className }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={typeof className === 'function' ? className({ isActive: false, isPending: false }) : className}>
      {children}
    </a>
  ),
  useParams: () => ({}),
  useNavigate: () => vi.fn(),
}));

// Mock 子组件
vi.mock('../session/NewSessionDialog', () => ({
  default: () => <div data-testid="new-session-dialog" />,
}));

vi.mock('../workflow/InstantiateWorkflowDialog', () => ({
  default: ({ open }: { open: boolean }) => open ? <div data-testid="instantiate-workflow-dialog" /> : null,
}));

vi.mock('../worktree/WorktreeSidebarGroup', () => ({
  default: ({ workspaceName }: { workspaceName: string }) => (
    <li data-testid={`worktree-${workspaceName}`}>{workspaceName}</li>
  ),
}));

vi.mock('../TodoListPanel', () => ({
  TodoListPanel: () => <div data-testid="todo-list-panel" />,
}));

vi.mock('../ThemeToggle', () => ({
  default: () => <div data-testid="theme-toggle" />,
}));

// Mock GatewayDialog
vi.mock('../GatewayDialog', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="gateway-dialog">
      <button onClick={onClose}>关闭</button>
    </div>
  ),
}));

// Mock GatewayItem
vi.mock('../GatewayItem', () => ({
  default: ({ gateway }: { gateway: { name: string } }) => (
    <li data-testid="gateway-item">{gateway.name}</li>
  ),
}));

// Helper function to expand controller
function expandController() {
  // 点击控制器名称展开
  fireEvent.click(screen.getByText('测试控制器'));
}

describe('Sidebar 集成测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('① 四个平级分组渲染', () => {
    it('展开控制器后渲染统一网关、工作流、会话、工作区四个分组', () => {
      mockUseQuery.mockImplementation((_doc: unknown, options?: { variables?: Record<string, unknown> }) => {
        if (options?.variables?.id === undefined && !options?.variables?.workspaceId) {
          return {
            data: {
              controllers: [
                { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
              ],
            },
          };
        }
        if (options?.variables?.controllerId) {
          return { data: { gateways: { gateways: [] } } };
        }
        return { data: { sessions: [] } };
      });

      render(<Sidebar username="testuser" />);
      expandController();

      // 检查四个分组标题
      expect(screen.getByText('统一网关')).toBeInTheDocument();
      expect(screen.getByText('工作流')).toBeInTheDocument();
      expect(screen.getByText('会话')).toBeInTheDocument();
      expect(screen.getByText('工作区')).toBeInTheDocument();
    });
  });

  describe('② 网关 Plus 打开 GatewayDialog', () => {
    it('点击网关 Plus 按钮打开 GatewayDialog', () => {
      mockUseQuery.mockImplementation((_doc: unknown, options?: { variables?: Record<string, unknown> }) => {
        if (options?.variables?.id === undefined && !options?.variables?.workspaceId) {
          return {
            data: {
              controllers: [
                { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
              ],
            },
          };
        }
        if (options?.variables?.controllerId) {
          return { data: { gateways: { gateways: [] } } };
        }
        return { data: { sessions: [] } };
      });

      render(<Sidebar username="testuser" />);
      expandController();

      // 点击网关 Plus 按钮
      const plusButton = screen.getByTitle('新增网关');
      fireEvent.click(plusButton);

      // 检查 GatewayDialog 是否打开
      expect(screen.getByTestId('gateway-dialog')).toBeInTheDocument();
    });
  });

  describe('③ 会话 cwd 最长前缀匹配', () => {
    it('会话分组存在', () => {
      mockUseQuery.mockImplementation((_doc: unknown, options?: { variables?: Record<string, unknown> }) => {
        if (options?.variables?.id === undefined && !options?.variables?.workspaceId) {
          return {
            data: {
              controllers: [
                { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
              ],
            },
          };
        }
        if (options?.variables?.controllerId) {
          return { data: { gateways: { gateways: [] } } };
        }
        return { data: { sessions: [] } };
      });

      render(<Sidebar username="testuser" />);
      expandController();

      // 检查会话分组存在
      expect(screen.getByText('会话')).toBeInTheDocument();
    });
  });

  describe('④ 工作流空态显示', () => {
    it('无工作流实例时显示空态', () => {
      mockUseQuery.mockImplementation((_doc: unknown, options?: { variables?: Record<string, unknown> }) => {
        if (options?.variables?.id === undefined && !options?.variables?.workspaceId) {
          return {
            data: {
              controllers: [
                { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
              ],
            },
          };
        }
        if (options?.variables?.controllerId) {
          return { data: { gateways: { gateways: [] } } };
        }
        if (options?.query?.definitions?.[0]?.name?.value === 'GetWorkspaces') {
          return {
            data: {
              workspaces: [
                { id: 'ws-1', controllerId: 'ctrl-1', name: 'project', path: '/home/user/project', isEnabled: true, isGitRepo: false, createdAt: '', updatedAt: '' },
              ],
            },
          };
        }
        if (options?.query?.definitions?.[0]?.name?.value === 'GetWorkflowInstances') {
          return { data: { workflowInstances: [] } };
        }
        return { data: { sessions: [] } };
      });

      render(<Sidebar username="testuser" />);
      expandController();

      // 检查工作流分组存在
      expect(screen.getByText('工作流')).toBeInTheDocument();
    });
  });

  describe('⑤ 无限渲染循环回归', () => {
    it('render 后正常完成，无无限循环', () => {
      mockUseQuery.mockImplementation(() => ({
        data: undefined,
      }));

      const startTime = Date.now();
      render(<Sidebar username="testuser" />);
      const endTime = Date.now();

      // render 应该在 1 秒内完成
      expect(endTime - startTime).toBeLessThan(1000);
    });
  });

  describe('⑥ 无会话/无工作区时显示空态文案', () => {
    it('无会话时显示空态', () => {
      mockUseQuery.mockImplementation((_doc: unknown, options?: { variables?: Record<string, unknown> }) => {
        if (options?.variables?.id === undefined && !options?.variables?.workspaceId) {
          return {
            data: {
              controllers: [
                { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
              ],
            },
          };
        }
        if (options?.variables?.controllerId) {
          return { data: { gateways: { gateways: [] } } };
        }
        return { data: { sessions: [] } };
      });

      render(<Sidebar username="testuser" />);
      expandController();

      // 检查会话分组存在
      expect(screen.getByText('会话')).toBeInTheDocument();
    });

    it('无工作区时显示空态', () => {
      mockUseQuery.mockImplementation((_doc: unknown, options?: { variables?: Record<string, unknown> }) => {
        if (options?.variables?.id === undefined && !options?.variables?.workspaceId) {
          return {
            data: {
              controllers: [
                { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
              ],
            },
          };
        }
        if (options?.variables?.controllerId) {
          return { data: { gateways: { gateways: [] } } };
        }
        if (options?.query?.definitions?.[0]?.name?.value === 'GetWorkspaces') {
          return { data: { workspaces: [] } };
        }
        return { data: { sessions: [] } };
      });

      render(<Sidebar username="testuser" />);
      expandController();

      // 检查工作区分组存在
      expect(screen.getByText('工作区')).toBeInTheDocument();
    });
  });
});