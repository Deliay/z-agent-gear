import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WorkflowSidebarGroup from '../workflow/WorkflowSidebarGroup';
import type { WorkflowInstanceSummaryData } from '@/graphql/workflow';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('react-router-dom', () => ({
  NavLink: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock('../workflow/InstantiateWorkflowDialog', () => ({
  default: () => null,
}));

function makeInstance(overrides: Partial<WorkflowInstanceSummaryData> = {}): WorkflowInstanceSummaryData {
  return {
    id: 'inst-1',
    configuredWorkflowId: 'cfg-1',
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: '需求A开发',
    currentNodeNames: [],
    lastNodeName: null,
    lastNodeStatus: null,
    archived: false,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
    ...overrides,
  };
}

function mockQueries(active: WorkflowInstanceSummaryData[], archived: WorkflowInstanceSummaryData[]) {
  mockUseQuery.mockImplementation((_doc: unknown, options?: { variables?: { archived?: boolean } }) => ({
    data: { workflowInstances: options?.variables?.archived ? archived : active },
  }));
}

describe('WorkflowSidebarGroup 实例状态文案', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('有执行中节点时显示「执行中：节点名」', () => {
    mockQueries([makeInstance({ currentNodeNames: ['AI执行'] })], []);
    render(<WorkflowSidebarGroup workspaceId="ws-1" controllerId="ctrl-1" />);
    expect(screen.getByText('执行中：AI执行')).toBeDefined();
  });

  it('无执行中节点时显示最后执行节点及其状态', () => {
    mockQueries([makeInstance({ lastNodeName: '完成开发', lastNodeStatus: 'DONE' })], []);
    render(<WorkflowSidebarGroup workspaceId="ws-1" controllerId="ctrl-1" />);
    expect(screen.getByText('完成开发 · 已完成')).toBeDefined();
  });

  it('无任何状态时兜底显示「暂无执行中的节点」', () => {
    mockQueries([makeInstance()], []);
    render(<WorkflowSidebarGroup workspaceId="ws-1" controllerId="ctrl-1" />);
    expect(screen.getByText('暂无执行中的节点')).toBeDefined();
  });
});

describe('WorkflowSidebarGroup 已归档分组', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('已归档实例不混入活跃列表，收入默认折叠的「已归档」分组并显示数量', () => {
    mockQueries(
      [makeInstance({ id: 'inst-active', name: '活跃实例', currentNodeNames: ['AI执行'] })],
      [makeInstance({ id: 'inst-archived', name: '历史实例', archived: true })],
    );
    render(<WorkflowSidebarGroup workspaceId="ws-1" controllerId="ctrl-1" />);

    expect(screen.getByText('活跃实例')).toBeDefined();
    expect(screen.queryByText('历史实例')).toBeNull();

    const toggle = screen.getByRole('button', { name: /已归档（1）/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.getByText('历史实例')).toBeDefined();
    // 归档项同样展示最后执行节点状态
    expect(screen.getByText('暂无执行中的节点')).toBeDefined();
  });

  it('无已归档实例时不显示分组', () => {
    mockQueries([makeInstance()], []);
    render(<WorkflowSidebarGroup workspaceId="ws-1" controllerId="ctrl-1" />);
    expect(screen.queryByRole('button', { name: /已归档/ })).toBeNull();
  });
});
