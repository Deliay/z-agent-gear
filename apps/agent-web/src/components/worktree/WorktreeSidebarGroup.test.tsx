import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import WorktreeSidebarGroup from './WorktreeSidebarGroup';
import type { SessionData } from '@/graphql/types';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('react-router-dom', () => ({
  NavLink: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock('@/components/session/NewSessionDialog', () => ({ default: () => null }));
vi.mock('@/components/workflow/InstantiateWorkflowDialog', () => ({ default: () => null }));
vi.mock('./DeleteWorktreeConfirmDialog', () => ({ default: () => null }));

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'sess-1',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    controllerName: 'Controller 1',
    acpServerType: 'opencode',
    status: 'running',
    title: '会话A',
    externalSessionId: null,
    cwd: null,
    worktreePath: '/repo/.worktrees/feat-a',
    worktreeBranch: 'feat-a',
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T00:00:00Z',
    endedAt: null,
    ...overrides,
  };
}

function renderGroup(fallbackSessions: SessionData[] = [], workspaceName = 'my-repo') {
  return render(
    <WorktreeSidebarGroup
      workspaceId="ws-1"
      controllerId="ctrl-1"
      workspaceName={workspaceName}
      controllers={[]}
      onCreate={vi.fn()}
      fallbackSessions={fallbackSessions}
    />,
  );
}

describe('WorktreeSidebarGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('workspaceWorktrees 查询失败时回退为平铺展示 worktree 会话', () => {
    mockUseQuery.mockReturnValue({ data: undefined, error: new Error('network error') });

    renderGroup([makeSession()]);

    expect(screen.getByText('会话A')).toBeDefined();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/sessions/sess-1');
  });

  it('查询成功且有 worktree 时按分组展示', () => {
    mockUseQuery.mockReturnValue({
      data: {
        workspaceWorktrees: [
          {
            path: '/repo/.worktrees/feat-a',
            branch: 'feat-a',
            sessionCount: 1,
            sessions: [
              { id: 'sess-1', title: '会话A', status: 'running', worktreePath: '/repo/.worktrees/feat-a' },
            ],
          },
        ],
      },
    });

    renderGroup([makeSession()]);

    expect(screen.getByText('feat-a')).toBeDefined();
  });

  it('无 worktree 且无会话时渲染默认工作区条目且无删除入口', () => {
    mockUseQuery.mockReturnValue({ data: { workspaceWorktrees: [] } });

    renderGroup([], 'project');

    // 渲染默认工作区条目
    expect(screen.getByText('project（默认）')).toBeDefined();
    // 无删除按钮
    expect(screen.queryByRole('button', { name: '删除 Worktree' })).not.toBeInTheDocument();
  });

  it('无 worktree 但有根目录会话时，会话聚合在默认工作区条目下', () => {
    mockUseQuery.mockReturnValue({ data: { workspaceWorktrees: [] } });

    const rootSession = makeSession({ id: 'sess-root', title: '根目录会话', worktreePath: null, cwd: '/home/user/project' });
    renderGroup([rootSession], 'project');

    // 渲染默认工作区条目
    expect(screen.getByText('project（默认）')).toBeDefined();
    // 会话聚合在默认工作区下
    expect(screen.getByText('根目录会话')).toBeDefined();
  });
});