import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MainLayout from '../MainLayout';
import { HOME_OVERVIEW } from '../../graphql/home';
import { persistWorkspaceId, readPersistedWorkspaceId } from '../../stores/workspace';

const mockUseQuery = vi.fn();
const mockRefetch = vi.fn();
const mockNavigate = vi.fn();

const { sseOptions, mockToast, mockOpenHarnessLogin } = vi.hoisted(() => ({
  sseOptions: {} as {
    enabled?: boolean;
    onHarnessLoginRequired?: (data: unknown) => void;
    onHarnessLoginResolved?: (data: unknown) => void;
  },
  mockToast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
  mockOpenHarnessLogin: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('../../hooks/useUserEventStream', () => ({
  useUserEventStream: (options: typeof sseOptions) => {
    Object.assign(sseOptions, options);
  },
}));

vi.mock('../../stores/harnessLoginDialog', () => ({
  openHarnessLoginDialog: mockOpenHarnessLogin,
  resolveHarnessLoginDialog: vi.fn(() => true),
}));

vi.mock('../../components/harness/HarnessLoginDialog', () => ({
  HarnessLoginDialog: () => <div data-testid="harness-login-dialog" />,
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useApolloClient: () => ({ resetStore: vi.fn() }),
}));

vi.mock('react-router-dom', () => ({
  Outlet: () => <div data-testid="outlet" />,
  NavLink: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../stores/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'tester' }, loading: false }),
}));

const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: { value: false } }));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile.value,
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
      todos: [],
      unreadTodoCount: 0,
    },
  };
}

describe('MainLayout 首页聚合查询', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockIsMobile.value = false;
  });

  it('P1 持久化工作区失效时错误页仍执行清理并 refetch（不死锁）', () => {
    persistWorkspaceId('user-1', 'ws-deleted');
    mockUseQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: new Error('workspace not found'),
      refetch: mockRefetch,
    });

    render(<MainLayout />);

    expect(screen.getByText('首页数据加载失败')).toBeInTheDocument();
    // 错误页也挂载同步桥：清理非法持久化选择并立即重取
    expect(readPersistedWorkspaceId('user-1')).toBeNull();
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('T-UI4-RES6 桌面端挂载侧边栏拖拽热区，宽度走 CSS 变量（默认 17.5rem/280px）', () => {
    mockUseQuery.mockReturnValue({ data: homeData, loading: false, error: undefined, refetch: mockRefetch });
    const { container } = render(<MainLayout />);

    expect(screen.getByTestId('sidebar-resizer')).toBeInTheDocument();
    const grid = container.querySelector('.grid') as HTMLElement;
    expect(grid.className).toContain('var(--sidebar-width,17.5rem)_minmax(0,1fr)');
    expect(grid.style.getPropertyValue('--sidebar-width')).toBe('280px');
  });

  it('T-UIUX-SHELL1 / T-SIDEBAR-3: 桌面端挂载三层工作区外壳 ActivityRail，支持一键收起/展开二级列表栏、Ctrl/Cmd+B 快捷键与折叠态持久化', () => {
    mockUseQuery.mockReturnValue({ data: homeData, loading: false, error: undefined, refetch: mockRefetch });
    render(<MainLayout />);

    expect(screen.getByTestId('activity-rail')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();

    // 点击一级导航轨的折叠按钮收起二级列表栏并持久化
    fireEvent.click(screen.getByTestId('rail-toggle-sidebar'));
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-resizer')).not.toBeInTheDocument();
    expect(localStorage.getItem('sidebar-collapsed')).toBe('1');

    // Ctrl+B 快捷键重新展开二级列表栏并更新持久化
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(localStorage.getItem('sidebar-collapsed')).toBe('0');

    // 收起后点击任意领域图标自动展开列表栏
    fireEvent.click(screen.getByTestId('rail-toggle-sidebar'));
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rail-item-workflows'));
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(localStorage.getItem('sidebar-active-domain')).toBe('workflows');
  });

  it('T-UI4-RES7 移动端不渲染拖拽热区（移动布局不回归）', () => {
    mockIsMobile.value = true;
    mockUseQuery.mockReturnValue({ data: homeData, loading: false, error: undefined, refetch: mockRefetch });
    render(<MainLayout />);

    expect(screen.queryByTestId('sidebar-resizer')).not.toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    // Phase 10：移动端底部导航行（费用/设置可达）
    const bottomNav = screen.getByTestId('mobile-bottom-nav');
    expect(bottomNav).toHaveTextContent('费用');
    expect(bottomNav).toHaveTextContent('设置');
  });

  it('仅挂载一次 HOME_OVERVIEW 查询且 pollInterval 为 15000（T-F1）', () => {
    mockUseQuery.mockReturnValue({ data: homeData, loading: false, error: undefined, refetch: mockRefetch });

    render(<MainLayout />);

    // 工作区上下文查询（myWorkspaces/myTenants）与 HOME_OVERVIEW 各一次
    expect(mockUseQuery).toHaveBeenCalledWith(HOME_OVERVIEW, { pollInterval: 15000 });
    const homeCalls = mockUseQuery.mock.calls.filter(([query]) => query === HOME_OVERVIEW);
    expect(homeCalls).toHaveLength(1);
  });

  it('轮询期间 loading=true 但已有数据时不卸载子页面（T-F2）', () => {
    mockUseQuery.mockReturnValue({ data: homeData, loading: true, error: undefined, refetch: mockRefetch });

    render(<MainLayout />);

    // 子页面仍在渲染，未替换成整页 spinner
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.queryByLabelText('加载中…')).toBeNull();
  });

  it('整体加载失败展示错误与重试入口，重试发起一次请求（T-F3）', () => {
    mockUseQuery.mockReturnValue({ data: undefined, loading: false, error: new Error('网络错误'), refetch: mockRefetch });

    render(<MainLayout />);

    expect(screen.getByText('首页数据加载失败')).toBeInTheDocument();
    fireEvent.click(screen.getByText('重试'));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('全局挂载登录引导弹窗且启用用户级 SSE', () => {
    mockUseQuery.mockReturnValue({ data: homeData, loading: false, error: undefined, refetch: mockRefetch });

    render(<MainLayout />);

    expect(screen.getByTestId('harness-login-dialog')).toBeInTheDocument();
    expect(sseOptions.enabled).toBe(true);
    expect(typeof sseOptions.onHarnessLoginRequired).toBe('function');
    expect(typeof sseOptions.onHarnessLoginResolved).toBe('function');
  });

  it('SSE required 打开单例弹窗；resolved 关闭并 toast', () => {
    mockUseQuery.mockReturnValue({ data: homeData, loading: false, error: undefined, refetch: mockRefetch });
    render(<MainLayout />);

    const request = {
      requestId: 'hl-1',
      controllerId: 'ctrl-1',
      serverType: 'kimi_code',
      trigger: 'probe-options',
      url: 'https://www.kimi.com/code/authorize_device?user_code=4CQ4-0XIG',
      userCode: '4CQ4-0XIG',
      expiresAt: '2026-10-25T12:30:00.000Z',
    };
    sseOptions.onHarnessLoginRequired?.(request);
    expect(mockOpenHarnessLogin).toHaveBeenCalledWith(request);

    sseOptions.onHarnessLoginResolved?.({ requestId: 'hl-1', result: 'succeeded' });
    expect(mockToast.success).toHaveBeenCalledWith('Kimi Code 已登录');

    sseOptions.onHarnessLoginResolved?.({ requestId: 'hl-1', result: 'cancelled' });
    expect(mockToast.info).toHaveBeenCalledWith('Kimi Code 未登录');

    sseOptions.onHarnessLoginResolved?.({ requestId: 'hl-1', result: 'expired' });
    expect(mockToast.info).toHaveBeenCalledWith('登录未完成，可重试');

    sseOptions.onHarnessLoginResolved?.({ requestId: 'hl-1', result: 'failed', error: 'boom' });
    expect(mockToast.error).toHaveBeenCalledWith('boom');
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
