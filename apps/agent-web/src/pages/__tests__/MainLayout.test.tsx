import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MainLayout from '../MainLayout';
import { HOME_OVERVIEW } from '../../graphql/home';

const mockUseQuery = vi.fn();
const mockRefetch = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('react-router-dom', () => ({
  Outlet: () => <div data-testid="outlet" />,
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../stores/auth', () => ({
  useAuth: () => ({ user: { username: 'tester' }, loading: false }),
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../../components/Sidebar', () => ({
  default: () => <div data-testid="sidebar" />,
}));

const homeData = {
  homeOverview: {
    controllers: [],
    sessions: [],
    sessionTotalCount: 0,
    workspaces: [],
    workflowInstances: [],
    archivedWorkflowInstances: [],
    todos: [],
    unreadTodoCount: 0,
  },
};

function homeWithCloudHost(
  status: 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED',
  defaultSessionId: string | null,
) {
  return {
    homeOverview: {
      controllers: [
        {
          id: 'ctrl-cloud',
          name: '云电脑 A',
          hostname: 'cloud-host-1',
          type: 'cloud',
          status: 'online',
          keyId: 'key-1',
          version: '1.0.0',
          lastHeartbeatAt: null,
          createdAt: '',
          updatedAt: '',
          gateways: { gateways: [], total: 0, limit: 0 },
          cloudHost: {
            id: 'host-1',
            name: '云电脑 A',
            controllerId: 'ctrl-cloud',
            status,
            harnessTypes: ['OPENCODE'],
            defaultSessionId,
            activeSessionCount: 0,
            failureReason: null,
            deletedAt: null,
          },
        },
      ],
      sessions: [],
      sessionTotalCount: 0,
      workspaces: [],
      workflowInstances: [],
      archivedWorkflowInstances: [],
      todos: [],
      unreadTodoCount: 0,
    },
  };
}

describe('MainLayout 首页聚合查询', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('仅挂载一次 HOME_OVERVIEW 查询且 pollInterval 为 15000（T-F1）', () => {
    mockUseQuery.mockReturnValue({ data: homeData, loading: false, error: undefined, refetch: mockRefetch });

    render(<MainLayout />);

    expect(mockUseQuery).toHaveBeenCalledTimes(1);
    expect(mockUseQuery).toHaveBeenCalledWith(HOME_OVERVIEW, { pollInterval: 15000 });
  });

  it('轮询期间 loading=true 但已有数据时不卸载子页面（T-F2）', () => {
    mockUseQuery.mockReturnValue({ data: homeData, loading: true, error: undefined, refetch: mockRefetch });

    render(<MainLayout />);

    // 子页面仍在渲染，未替换成整页 spinner
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading…')).toBeNull();
  });

  it('整体加载失败展示错误与重试入口，重试发起一次请求（T-F3）', () => {
    mockUseQuery.mockReturnValue({ data: undefined, loading: false, error: new Error('网络错误'), refetch: mockRefetch });

    render(<MainLayout />);

    expect(screen.getByText('首页数据加载失败')).toBeInTheDocument();
    fireEvent.click(screen.getByText('重试'));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  describe('D-2 默认会话就绪后自动进入', () => {
    it('STARTING→RUNNING 且 defaultSessionId 非空时导航一次', () => {
      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('STARTING', null),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });

      const { rerender } = render(<MainLayout />);
      expect(mockNavigate).not.toHaveBeenCalled();

      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('RUNNING', 'sess-default-1'),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });
      rerender(<MainLayout />);

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/sessions/sess-default-1');
    });

    it('后续轮询保持 RUNNING 时不重复导航', () => {
      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('STARTING', null),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });

      const { rerender } = render(<MainLayout />);

      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('RUNNING', 'sess-default-1'),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });
      rerender(<MainLayout />);

      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('RUNNING', 'sess-default-1'),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });
      rerender(<MainLayout />);

      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });

    it('R2-5: STARTING→RUNNING(无 session)→RUNNING(有 session) 仍补跳一次', () => {
      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('STARTING', null),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });

      const { rerender } = render(<MainLayout />);

      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('RUNNING', null),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });
      rerender(<MainLayout />);
      expect(mockNavigate).not.toHaveBeenCalled();

      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('RUNNING', 'sess-late'),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });
      rerender(<MainLayout />);

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/sessions/sess-late');
    });

    it('首次加载即为 RUNNING 的旧主机不强制跳转', () => {
      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('RUNNING', 'sess-old'),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });

      render(<MainLayout />);

      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('STARTING→RUNNING 但 defaultSessionId 为空时不导航', () => {
      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('STARTING', null),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });

      const { rerender } = render(<MainLayout />);

      mockUseQuery.mockReturnValue({
        data: homeWithCloudHost('RUNNING', null),
        loading: false,
        error: undefined,
        refetch: mockRefetch,
      });
      rerender(<MainLayout />);

      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });
});
