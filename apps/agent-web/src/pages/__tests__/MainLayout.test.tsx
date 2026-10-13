import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MainLayout from '../MainLayout';
import { HOME_OVERVIEW } from '../../graphql/home';

const mockUseQuery = vi.fn();
const mockRefetch = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('react-router-dom', () => ({
  Outlet: () => <div data-testid="outlet" />,
  useLocation: () => ({ pathname: '/' }),
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
});
