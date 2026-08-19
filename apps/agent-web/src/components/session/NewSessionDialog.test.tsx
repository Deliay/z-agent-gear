import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import NewSessionDialog from './NewSessionDialog';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useLazyQuery: () => [vi.fn()],
}));

describe('NewSessionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({ data: undefined, loading: false });
  });

  it('预选择 worktree 模式下展示目标 worktree 路径', () => {
    render(
      <NewSessionDialog
        controllers={[{ id: 'ctrl-1', name: 'Controller 1', status: 'online' }]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        existingWorktreePath="/repo/.worktrees/feat-a"
        existingControllerId="ctrl-1"
        existingWorkspaceId="ws-1"
      />,
    );

    expect(screen.getByText('/repo/.worktrees/feat-a')).toBeDefined();
  });
});
