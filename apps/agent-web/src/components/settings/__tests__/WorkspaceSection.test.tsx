import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WorkspaceSection from '../WorkspaceSection';
import { GET_ACP_CAPABILITIES } from '../../../graphql/queries';
import { WORKSPACE_ARCHIVE_IMPACT, DELETE_WORKSPACE } from '../../../graphql/mutations';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

function mockQuery(overrides: Record<string, unknown> = {}) {
  return {
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

function baseWorkspaces() {
  return [
    { id: 'ws-1', userId: 'user-1', controllerId: 'ctrl-1', name: 'Project A', path: '/home/user/project-a', isEnabled: true, defaultBranch: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'ws-2', userId: 'user-1', controllerId: 'ctrl-1', name: 'Project B', path: '/home/user/project-b', isEnabled: false, defaultBranch: null, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
  ];
}

describe('WorkspaceSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultProps = { controllerId: 'ctrl-1' };

  it('should show loading state', () => {
    mockUseQuery.mockReturnValue(mockQuery({ loading: true }));
    mockUseMutation.mockReturnValue([vi.fn()]);

    render(<WorkspaceSection {...defaultProps} />);

    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('should show empty state when no workspaces', () => {
    mockUseQuery.mockReturnValue(mockQuery({ data: { controllerWorkspaces: [] } }));
    mockUseMutation.mockReturnValue([vi.fn()]);

    render(<WorkspaceSection {...defaultProps} />);

    expect(screen.getByText('暂无工作区，点击「添加」开始配置')).toBeDefined();
  });

  it('should display workspace list', () => {
    mockUseQuery.mockReturnValue(mockQuery({ data: { controllerWorkspaces: baseWorkspaces() } }));
    mockUseMutation.mockReturnValue([vi.fn()]);

    render(<WorkspaceSection {...defaultProps} />);

    expect(screen.getByText('Project A')).toBeDefined();
    expect(screen.getByText('Project B')).toBeDefined();
  });

  it('should call delete mutation on delete click', async () => {
    const refetch = vi.fn();
    const deleteMutate = vi.fn().mockResolvedValue({});
    mockUseQuery.mockReturnValue(mockQuery({ data: { controllerWorkspaces: baseWorkspaces() }, refetch }));
    mockUseMutation.mockReturnValue([deleteMutate]);

    render(<WorkspaceSection {...defaultProps} />);

    const deleteButtons = screen.getAllByText('删除');
    fireEvent.click(deleteButtons[0]);

    // impact 预查询（契约层 Mutation）为异步：删除经微任务后触发
    await waitFor(() =>
      expect(deleteMutate).toHaveBeenCalledWith({
        variables: { id: 'ws-1' },
        refetchQueries: [expect.any(Object), expect.any(Object)],
      }),
    );
  });

  it('should show clear confirmation when click clear', () => {
    mockUseQuery.mockReturnValue(mockQuery({ data: { controllerWorkspaces: baseWorkspaces() } }));
    mockUseMutation.mockReturnValue([vi.fn()]);

    render(<WorkspaceSection {...defaultProps} />);

    fireEvent.click(screen.getByText('清空'));

    expect(screen.getByText('确定要清空所有工作区吗？此操作不可撤销。')).toBeDefined();
  });

  it('should display enabled/disabled states for workspaces', () => {
    mockUseQuery.mockReturnValue(mockQuery({ data: { controllerWorkspaces: baseWorkspaces() } }));
    mockUseMutation.mockReturnValue([vi.fn()]);

    render(<WorkspaceSection {...defaultProps} />);

    const toggles = screen.getAllByRole('button').filter((b) => b.className.includes('h-4 w-4'));
    expect(toggles.length).toBe(2);
  });

  it('should open AddWorkspaceDialog on add button click', () => {
    mockUseQuery.mockReturnValue(mockQuery({ data: { controllerWorkspaces: baseWorkspaces() } }));
    mockUseMutation.mockReturnValue([vi.fn()]);

    render(<WorkspaceSection {...defaultProps} />);

    const addButton = screen.getByText('添加');
    fireEvent.click(addButton);

    expect(screen.getByText('选择要添加到工作区的目录')).toBeDefined();
  });

  it('should expand workspace card on chevron click', () => {
    mockUseQuery.mockReturnValue(mockQuery({ data: { controllerWorkspaces: baseWorkspaces() } }));
    mockUseMutation.mockReturnValue([vi.fn()]);

    render(<WorkspaceSection {...defaultProps} />);

    const chevronButtons = screen.getAllByRole('button').filter(
      (b) => b.querySelector('svg') !== null,
    );
    fireEvent.click(chevronButtons[0]);

    expect(screen.getByText('检测 Git 状态中...')).toBeDefined();
  });
});

describe('工作区删除/清空连带归档确认（T-WEB4）', () => {
  const defaultProps = { controllerId: 'ctrl-1' };

  /**
   * `workspaceArchiveImpact` 在契约层是 Mutation（contracts/agent-session.graphql），
   * 因此经 `useMutation` 分流返回给定 sessionCount（null = 取数失败/拒绝）；
   * `useQuery` 只保留工作区列表与 ACP 能力两个查询。
   */
  function mockWithImpact(sessionCount: number | null) {
    const impactMutate =
      sessionCount == null
        ? vi.fn().mockRejectedValue(new Error('impact failed'))
        : vi.fn().mockResolvedValue({ data: { workspaceArchiveImpact: { sessionCount } } });
    const deleteMutate = vi.fn().mockResolvedValue({});
    mockUseQuery.mockImplementation((query: unknown) => {
      if (query === GET_ACP_CAPABILITIES) {
        return { data: null, loading: false };
      }
      return { data: { controllerWorkspaces: baseWorkspaces() }, loading: false, refetch: vi.fn() };
    });
    mockUseMutation.mockImplementation((query: unknown) => {
      if (query === WORKSPACE_ARCHIVE_IMPACT) return [impactMutate];
      if (query === DELETE_WORKSPACE) return [deleteMutate];
      return [vi.fn().mockResolvedValue({})];
    });
    return { impactMutate, deleteMutate };
  }

  it('T-WEB4 N>0 时弹出含数量的删除确认框且不直接删除', async () => {
    const { impactMutate, deleteMutate } = mockWithImpact(3);

    render(<WorkspaceSection {...defaultProps} />);
    fireEvent.click(screen.getAllByText('删除')[0]);

    expect(
      await screen.findByText('删除工作区将同时归档其下 3 个会话，是否继续？'),
    ).toBeInTheDocument();
    expect(impactMutate).toHaveBeenCalledWith({ variables: { id: 'ws-1' } });
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it('T-WEB4 确认删除后才调用 deleteWorkspace', async () => {
    const { deleteMutate } = mockWithImpact(3);

    render(<WorkspaceSection {...defaultProps} />);
    fireEvent.click(screen.getAllByText('删除')[0]);
    await screen.findByText('删除工作区将同时归档其下 3 个会话，是否继续？');

    fireEvent.click(screen.getByText('确认删除'));

    await waitFor(() =>
      expect(deleteMutate).toHaveBeenCalledWith({
        variables: { id: 'ws-1' },
        refetchQueries: [expect.any(Object), expect.any(Object)],
      }),
    );
  });

  it('T-WEB4 取消删除时不调用 deleteWorkspace', async () => {
    const { deleteMutate } = mockWithImpact(2);

    render(<WorkspaceSection {...defaultProps} />);
    fireEvent.click(screen.getAllByText('删除')[0]);
    await screen.findByText('删除工作区将同时归档其下 2 个会话，是否继续？');

    fireEvent.click(screen.getByText('取消'));

    expect(screen.queryByText(/删除工作区将同时归档其下/)).not.toBeInTheDocument();
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it('T-WEB4 N=0 时不弹确认直接删除（保持现状）', async () => {
    const { deleteMutate } = mockWithImpact(0);

    render(<WorkspaceSection {...defaultProps} />);
    fireEvent.click(screen.getAllByText('删除')[0]);

    await waitFor(() =>
      expect(deleteMutate).toHaveBeenCalledWith({
        variables: { id: 'ws-1' },
        refetchQueries: [expect.any(Object), expect.any(Object)],
      }),
    );
    expect(screen.queryByText(/删除工作区将同时归档其下/)).not.toBeInTheDocument();
  });

  it('T-WEB4 impact 取数失败不阻断：降级为直接删除', async () => {
    const { impactMutate, deleteMutate } = mockWithImpact(null);

    render(<WorkspaceSection {...defaultProps} />);
    fireEvent.click(screen.getAllByText('删除')[0]);

    await waitFor(() => expect(impactMutate).toHaveBeenCalledWith({ variables: { id: 'ws-1' } }));
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledOnce());
    expect(screen.queryByText(/删除工作区将同时归档其下/)).not.toBeInTheDocument();
  });

  it('T-WEB4 清空确认追加各工作区连带合计数量', async () => {
    const { impactMutate } = mockWithImpact(2);

    render(<WorkspaceSection {...defaultProps} />);
    fireEvent.click(screen.getByText('清空'));

    expect(screen.getByText('确定要清空所有工作区吗？此操作不可撤销。')).toBeDefined();
    expect(await screen.findByText('将同时归档其下 4 个会话')).toBeInTheDocument();
    expect(impactMutate).toHaveBeenCalledTimes(2);
  });

  it('T-WEB4 清空确认取数失败时降级为不展示数量（不阻断确认）', async () => {
    const { impactMutate } = mockWithImpact(null);

    render(<WorkspaceSection {...defaultProps} />);
    fireEvent.click(screen.getByText('清空'));

    expect(screen.getByText('确定要清空所有工作区吗？此操作不可撤销。')).toBeDefined();
    await waitFor(() => expect(impactMutate).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/将同时归档其下/)).not.toBeInTheDocument();
  });
});
