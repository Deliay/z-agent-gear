import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WorkspaceSection from '../WorkspaceSection';

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

    expect(deleteMutate).toHaveBeenCalledWith({
      variables: { id: 'ws-1' },
      refetchQueries: [expect.any(Object)],
    });
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
