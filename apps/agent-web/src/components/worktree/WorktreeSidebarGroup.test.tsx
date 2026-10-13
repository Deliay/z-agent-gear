import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import WorktreeSidebarGroup from './WorktreeSidebarGroup';
import type { SessionData, WorkspaceWorktreeData } from '@/graphql/types';

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

function makeWorktree(): WorkspaceWorktreeData {
  return {
    path: '/repo/.worktrees/feat-a',
    branch: 'feat-a',
    sessionCount: 1,
    sessions: [
      { id: 'sess-1', title: '会话A', status: 'running', worktreePath: '/repo/.worktrees/feat-a' },
    ],
  };
}

function renderGroup(
  worktrees: WorkspaceWorktreeData[] = [],
  fallbackSessions: SessionData[] = [],
  workspaceName = 'my-repo',
) {
  return render(
    <WorktreeSidebarGroup
      workspaceId="ws-1"
      controllerId="ctrl-1"
      workspaceName={workspaceName}
      controllers={[]}
      worktrees={worktrees}
      onCreate={vi.fn()}
      fallbackSessions={fallbackSessions}
    />,
  );
}

describe('WorktreeSidebarGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('有 worktree 时按分组展示（消费下传数据）', () => {
    renderGroup([makeWorktree()], [makeSession()]);

    expect(screen.getByText('feat-a')).toBeDefined();
  });

  it('无 worktree 且无会话时渲染默认工作区条目且无删除入口', () => {
    renderGroup([], [], 'project');

    // 渲染默认工作区条目
    expect(screen.getByText('project（默认）')).toBeDefined();
    // 无删除按钮
    expect(screen.queryByRole('button', { name: '删除 Worktree' })).not.toBeInTheDocument();
  });

  it('无 worktree 但有根目录会话时，会话聚合在默认工作区条目下', () => {
    const rootSession = makeSession({ id: 'sess-root', title: '根目录会话', worktreePath: null, cwd: '/home/user/project' });
    renderGroup([], [rootSession], 'project');

    // 渲染默认工作区条目
    expect(screen.getByText('project（默认）')).toBeDefined();
    // 会话聚合在默认工作区下
    expect(screen.getByText('根目录会话')).toBeDefined();
  });
});
