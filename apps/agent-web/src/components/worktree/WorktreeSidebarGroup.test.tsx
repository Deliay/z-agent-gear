import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import WorktreeSidebarGroup from './WorktreeSidebarGroup';
import type { SessionData, WorkspaceWorktreeData } from '@/graphql/types';

vi.mock('react-router-dom', () => ({
  NavLink: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const newSessionDialog = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('@/components/session/NewSessionDialog', () => ({
  default: (props: Record<string, unknown>) => {
    newSessionDialog.props = props;
    return null;
  },
}));
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

  it('R-4: 预选 worktree 建会话时透传 modeId/modelId 与路径', () => {
    const onCreate = vi.fn();
    render(
      <WorktreeSidebarGroup
        workspaceId="ws-1"
        controllerId="ctrl-1"
        workspaceName="my-repo"
        controllers={[]}
        worktrees={[makeWorktree()]}
        onCreate={onCreate}
        fallbackSessions={[makeSession()]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '新建会话' }));
    const props = newSessionDialog.props as {
      onCreate: (...args: unknown[]) => void;
    };
    expect(props).toBeTruthy();
    props.onCreate(
      'ctrl-1',
      'opencode',
      'ws-1',
      false,
      undefined,
      ['mcp-1'],
      '/repo/.worktrees/feat-a',
      'mode-1',
      'model-1',
    );

    expect(onCreate).toHaveBeenCalledWith(
      'ctrl-1',
      'opencode',
      'ws-1',
      false,
      undefined,
      ['mcp-1'],
      '/repo/.worktrees/feat-a',
      'mode-1',
      'model-1',
    );
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
