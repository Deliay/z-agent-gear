import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import HomePage from '../HomePage';
import type { HomeOverviewData } from '../../graphql/types';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

const homeState: { data: HomeOverviewData | null } = { data: null };

vi.mock('../../stores/homeOverview', () => ({
  useHomeOverview: () => ({ data: homeState.data, loading: false, error: undefined, refetch: vi.fn() }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

function makeHome(overrides: Partial<HomeOverviewData> = {}): HomeOverviewData {
  return {
    controllers: [
      { id: 'ctrl-1', name: '在线主机', status: 'online' },
      { id: 'ctrl-2', name: '离线主机', status: 'offline' },
    ],
    sessions: [
      {
        id: 'sess-1',
        userId: 'u',
        controllerId: 'ctrl-1',
        controllerName: '在线主机',
        acpServerType: 'opencode',
        status: 'idling',
        title: '重构会话',
        externalSessionId: null,
        cwd: null,
        worktreePath: null,
        worktreeBranch: null,
        archived: false,
        createdAt: '2026-11-27T00:00:00.000Z',
        updatedAt: '2026-11-27T02:00:00.000Z',
        endedAt: null,
      },
    ],
    sessionTotalCount: 12,
    workspaces: [],
    workflowInstances: [
      {
        id: 'wf-1',
        configuredWorkflowId: null,
        controllerId: 'ctrl-1',
        workspaceId: 'ws-1',
        name: 'UI 重构工作流',
        currentNodeNames: ['实现'],
        lastNodeName: '实现',
        lastNodeStatus: 'RUNNING',
        archived: false,
        workspace: { id: 'ws-1', name: 'z-agent-gear' },
        controller: { id: 'ctrl-1', name: '在线主机' },
        createdAt: '',
        updatedAt: '2026-11-27T03:00:00.000Z',
      },
    ],
    todos: [
      {
        id: 'todo-1',
        type: 'elicitation',
        priority: 'normal',
        title: '确认实现范围',
        description: null,
        isRead: false,
        data: null,
        resolvedAt: null,
        createdAt: '2026-11-27T00:00:00.000Z',
      },
      {
        id: 'todo-2',
        type: 'elicitation',
        priority: 'normal',
        title: '已处理',
        description: null,
        isRead: true,
        data: null,
        resolvedAt: '2026-11-27T01:00:00.000Z',
        createdAt: '2026-11-27T00:00:00.000Z',
      },
    ],
    unreadTodoCount: 1,
    sessionReviews: [
      {
        id: 'review-1',
        sessionId: 'sess-1',
        sessionTitle: '重构会话',
        files: ['src/a.ts'],
        status: 'PENDING',
        fileReviews: null,
        comment: null,
        cancelReason: null,
        createdAt: '2026-11-27T00:00:00.000Z',
        resolvedAt: null,
      },
    ],
    configuredWorkflows: [],
    workflowTemplates: [],
    workspaceContext: { myWorkspaces: [], myTenants: [] },
    ...overrides,
  } as HomeOverviewData;
}

describe('HomePage（场景 B：概览与多租户）', () => {
  it('T-HOME-KPI: 3 列 KPI 统计卡使用 tabular-nums，最近会话卡片可直达', () => {
    homeState.data = makeHome();
    render(<HomePage />);

    expect(screen.getByTestId('home-kpi-grid').className).toContain('sm:grid-cols-3');
    for (const id of ['home-kpi-online', 'home-kpi-sessions', 'home-kpi-controllers']) {
      expect(screen.getByTestId(id).className).toContain('tabular-nums');
    }
    expect(screen.getByTestId('home-kpi-online')).toHaveTextContent('1');
    expect(screen.getByTestId('home-kpi-sessions')).toHaveTextContent('12');
    expect(screen.getByTestId('home-kpi-controllers')).toHaveTextContent('2');

    fireEvent.click(screen.getByText('重构会话'));
    expect(navigateMock).toHaveBeenCalledWith('/sessions/sess-1');
  });

  it('T-HOME-KPI: 工作流与协同动态区消费聚合数据（零新增查询）', () => {
    homeState.data = makeHome();
    render(<HomePage />);

    expect(screen.getByTestId('home-dynamic-workflow')).toHaveTextContent('UI 重构工作流');
    expect(screen.getByTestId('home-dynamic-collab')).toHaveTextContent('2 项');
    expect(screen.getByTestId('home-dynamic-collab')).toHaveTextContent('待评审：重构会话');
    expect(screen.getByTestId('home-dynamic-collab')).toHaveTextContent('确认实现范围');
  });

  it('T-HOME-KPI: 空动态区展示收敛空态', () => {
    homeState.data = makeHome({ workflowInstances: [], todos: [], sessionReviews: [] });
    render(<HomePage />);

    expect(screen.getByTestId('home-dynamic-workflow')).toHaveTextContent('暂无进行中的工作流');
    expect(screen.getByTestId('home-dynamic-collab')).toHaveTextContent('暂无待处理的提问、审批与评审');
  });
});
