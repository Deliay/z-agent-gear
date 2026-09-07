import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Sidebar from '../Sidebar';
import { GET_SESSIONS, GET_CONTROLLERS, GET_WORKSPACES } from '../../graphql/queries';
import { GET_WORKFLOW_INSTANCES } from '../../graphql/workflow';

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

vi.mock('../TodoListPanel', () => ({
  TodoListPanel: () => <div data-testid="todo-list-panel" />,
}));

vi.mock('../ThemeToggle', () => ({
  default: () => <div data-testid="theme-toggle" />,
}));

// Mock GatewayDialog（更深层）
vi.mock('../GatewayDialog', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="gateway-dialog">
      <button onClick={onClose}>关闭</button>
    </div>
  ),
}));

// Mock GatewayItem（更深层）
vi.mock('../GatewayItem', () => ({
  default: ({ gateway }: { gateway: { name: string } }) => (
    <li data-testid="gateway-item">{gateway.name}</li>
  ),
}));

// Helper: mock 查询返回值
function mockQuery(data: Record<string, unknown>) {
  return { data };
}

// Helper: 展开控制器
function expandController() {
  fireEvent.click(screen.getByText('测试控制器'));
}

// Helper: 根据查询文档分发 mock
function mockQueryByDoc(doc: unknown, data: Record<string, unknown>) {
  return { data };
}

describe('Sidebar 集成测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('① 四个平级分组渲染', () => {
    it('展开控制器后渲染统一网关、工作流、会话、工作区四个分组', () => {
      mockUseQuery.mockImplementation((_doc: unknown) => {
        const doc = _doc as { definitions: Array<{ name: { value: string } }> };
        const queryName = doc.definitions?.[0]?.name?.value;

        if (queryName === 'GetControllers') {
          return mockQuery({
            controllers: [
              { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetGateways') {
          return mockQuery({ gateways: { gateways: [] } });
        }
        if (queryName === 'GetSessions') {
          return mockQuery({ sessions: [] });
        }
        if (queryName === 'GetWorkspaces') {
          return mockQuery({ workspaces: [] });
        }
        if (queryName === 'GetWorkflowInstances') {
          return mockQuery({ workflowInstances: [] });
        }
        return mockQuery({});
      });

      render(<Sidebar username="testuser" />);
      expandController();

      expect(screen.getByText('统一网关')).toBeInTheDocument();
      expect(screen.getByText('工作流')).toBeInTheDocument();
      expect(screen.getByText('会话')).toBeInTheDocument();
      expect(screen.getByText('工作区')).toBeInTheDocument();
    });
  });

  describe('② 网关 Plus 打开 GatewayDialog', () => {
    it('点击网关 Plus 按钮打开 GatewayDialog', () => {
      mockUseQuery.mockImplementation((_doc: unknown) => {
        const doc = _doc as { definitions: Array<{ name: { value: string } }> };
        const queryName = doc.definitions?.[0]?.name?.value;

        if (queryName === 'GetControllers') {
          return mockQuery({
            controllers: [
              { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetGateways') {
          return mockQuery({ gateways: { gateways: [] } });
        }
        return mockQuery({ sessions: [] });
      });

      render(<Sidebar username="testuser" />);
      expandController();

      const plusButton = screen.getByTitle('新增网关');
      fireEvent.click(plusButton);

      expect(screen.getByTestId('gateway-dialog')).toBeInTheDocument();
    });
  });

  describe('③ 会话 cwd 最长前缀匹配', () => {
    it('显示最深匹配的工作区名', () => {
      mockUseQuery.mockImplementation((_doc: unknown) => {
        const doc = _doc as { definitions: Array<{ name: { value: string } }> };
        const queryName = doc.definitions?.[0]?.name?.value;

        if (queryName === 'GetControllers') {
          return mockQuery({
            controllers: [
              { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetSessions') {
          return mockQuery({
            sessions: [
              { id: 'session-1', title: '深层会话', status: 'active', controllerId: 'ctrl-1', cwd: '/home/user/project/sub/deep', worktreePath: null, workspaceId: null, workflowInstanceId: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetWorkspaces') {
          return mockQuery({
            workspaces: [
              { id: 'ws-1', controllerId: 'ctrl-1', name: 'project', path: '/home/user/project', isEnabled: true, isGitRepo: false, createdAt: '', updatedAt: '' },
              { id: 'ws-2', controllerId: 'ctrl-1', name: 'project-sub', path: '/home/user/project/sub', isEnabled: true, isGitRepo: false, createdAt: '', updatedAt: '' },
            ],
          });
        }
        return mockQuery({ gateways: { gateways: [] } });
      });

      render(<Sidebar username="testuser" />);
      expandController();

      // 应显示最深匹配的工作区名 project-sub
      expect(screen.getByText('深层会话')).toBeInTheDocument();
      expect(screen.getByText('project-sub')).toBeInTheDocument();
    });

    it('不匹配任何工作区时显示未知工作区', () => {
      mockUseQuery.mockImplementation((_doc: unknown) => {
        const doc = _doc as { definitions: Array<{ name: { value: string } }> };
        const queryName = doc.definitions?.[0]?.name?.value;

        if (queryName === 'GetControllers') {
          return mockQuery({
            controllers: [
              { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetSessions') {
          return mockQuery({
            sessions: [
              { id: 'session-1', title: '孤立会话', status: 'active', controllerId: 'ctrl-1', cwd: '/unknown/path', worktreePath: null, workspaceId: null, workflowInstanceId: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetWorkspaces') {
          return mockQuery({
            workspaces: [
              { id: 'ws-1', controllerId: 'ctrl-1', name: 'project', path: '/home/user', isEnabled: true, isGitRepo: false, createdAt: '', updatedAt: '' },
            ],
          });
        }
        return mockQuery({ gateways: { gateways: [] } });
      });

      render(<Sidebar username="testuser" />);
      expandController();

      expect(screen.getByText('孤立会话')).toBeInTheDocument();
      expect(screen.getByText('未知工作区')).toBeInTheDocument();
    });
  });

  describe('④ 工作流空态与实例上报后切换', () => {
    it('无工作流实例时显示空态', () => {
      mockUseQuery.mockImplementation((_doc: unknown) => {
        const doc = _doc as { definitions: Array<{ name: { value: string } }> };
        const queryName = doc.definitions?.[0]?.name?.value;

        if (queryName === 'GetControllers') {
          return mockQuery({
            controllers: [
              { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetWorkspaces') {
          return mockQuery({
            workspaces: [
              { id: 'ws-1', controllerId: 'ctrl-1', name: 'project', path: '/home/user/project', isEnabled: true, isGitRepo: false, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetWorkflowInstances') {
          return mockQuery({ workflowInstances: [] });
        }
        return mockQuery({ sessions: [], gateways: { gateways: [] } });
      });

      render(<Sidebar username="testuser" />);
      expandController();

      expect(screen.getByText('无工作流实例')).toBeInTheDocument();
    });

    it('实例上报后从空态切换为列表', () => {
      let workflowInstances: Array<{ id: string; name: string; currentNodeNames: string[]; lastNodeName: string | null; lastNodeStatus: string | null; archived: boolean; createdAt: string; updatedAt: string }> = [];

      mockUseQuery.mockImplementation((_doc: unknown) => {
        const doc = _doc as { definitions: Array<{ name: { value: string } }> };
        const queryName = doc.definitions?.[0]?.name?.value;

        if (queryName === 'GetControllers') {
          return mockQuery({
            controllers: [
              { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetWorkspaces') {
          return mockQuery({
            workspaces: [
              { id: 'ws-1', controllerId: 'ctrl-1', name: 'project', path: '/home/user/project', isEnabled: true, isGitRepo: false, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetWorkflowInstances') {
          return mockQuery({ workflowInstances });
        }
        return mockQuery({ sessions: [], gateways: { gateways: [] } });
      });

      const { rerender } = render(<Sidebar username="testuser" />);
      expandController();

      // 初始空态
      expect(screen.getByText('无工作流实例')).toBeInTheDocument();

      // 模拟实例上报
      act(() => {
        workflowInstances = [
          { id: 'inst-1', name: '需求A开发', currentNodeNames: [], lastNodeName: null, lastNodeStatus: null, archived: false, createdAt: '', updatedAt: '' },
        ];
        rerender(<Sidebar username="testuser" />);
      });

      // 空态消失，实例出现
      expect(screen.queryByText('无工作流实例')).not.toBeInTheDocument();
      expect(screen.getByText('需求A开发')).toBeInTheDocument();
    });
  });

  describe('⑤ 无限渲染循环回归', () => {
    it('render 后正常完成，无 Maximum update depth 错误', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockUseQuery.mockImplementation((_doc: unknown) => {
        const doc = _doc as { definitions: Array<{ name: { value: string } }> };
        const queryName = doc.definitions?.[0]?.name?.value;

        if (queryName === 'GetControllers') {
          return mockQuery({
            controllers: [
              { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetWorkspaces') {
          return mockQuery({
            workspaces: [
              { id: 'ws-1', controllerId: 'ctrl-1', name: 'project', path: '/home/user/project', isEnabled: true, isGitRepo: false, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetWorkflowInstances') {
          return mockQuery({ workflowInstances: [] });
        }
        return mockQuery({ sessions: [], gateways: { gateways: [] } });
      });

      render(<Sidebar username="testuser" />);
      expandController();

      // 确认无 Maximum update depth 错误
      const updateDepthErrors = consoleSpy.mock.calls.filter(
        (call) => call[0]?.toString().includes('Maximum update depth')
      );
      expect(updateDepthErrors).toHaveLength(0);

      consoleSpy.mockRestore();
    });
  });

  describe('⑥ 无会话/无工作区时显示空态文案', () => {
    it('无会话时显示「无会话」', () => {
      mockUseQuery.mockImplementation((_doc: unknown) => {
        const doc = _doc as { definitions: Array<{ name: { value: string } }> };
        const queryName = doc.definitions?.[0]?.name?.value;

        if (queryName === 'GetControllers') {
          return mockQuery({
            controllers: [
              { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetSessions') {
          return mockQuery({ sessions: [] });
        }
        return mockQuery({ gateways: { gateways: [] }, workspaces: [] });
      });

      render(<Sidebar username="testuser" />);
      expandController();

      expect(screen.getByText('无会话')).toBeInTheDocument();
    });

    it('无工作区时显示「无工作区」', () => {
      mockUseQuery.mockImplementation((_doc: unknown) => {
        const doc = _doc as { definitions: Array<{ name: { value: string } }> };
        const queryName = doc.definitions?.[0]?.name?.value;

        if (queryName === 'GetControllers') {
          return mockQuery({
            controllers: [
              { id: 'ctrl-1', name: '测试控制器', hostname: 'localhost', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '', updatedAt: '' },
            ],
          });
        }
        if (queryName === 'GetWorkspaces') {
          return mockQuery({ workspaces: [] });
        }
        return mockQuery({ sessions: [], gateways: { gateways: [] } });
      });

      render(<Sidebar username="testuser" />);
      expandController();

      expect(screen.getByText('无工作区')).toBeInTheDocument();
    });
  });
});