import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Sidebar from '../../Sidebar';
import type { HomeOverviewData, SessionData } from '@/graphql/types';
import type { WorkflowInstanceSummaryData } from '@/graphql/workflow';

const mockUseMutation = vi.fn();
const mockUseQuery = vi.fn();
const mockUseHomeOverview = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockUseMutation, { loading: false }],
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useApolloClient: () => ({ resetStore: vi.fn() }),
}));

vi.mock('@/stores/homeOverview', () => ({
  useHomeOverview: () => mockUseHomeOverview(),
}));

vi.mock('react-router-dom', () => ({
  NavLink: ({ children, to, title, className }: { children: React.ReactNode; to: string; title?: string; className?: string | ((s: { isActive: boolean; isPending: boolean }) => string) }) => (
    <a href={to} title={title} className={typeof className === 'function' ? className({ isActive: false, isPending: false }) : className}>
      {children}
    </a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({}),
}));

vi.mock('../../TodoListPanel', () => ({
  TodoListPanel: () => <div data-testid="todo-list-panel" />,
}));

vi.mock('../../ThemeToggle', () => ({
  default: () => <div data-testid="theme-toggle" />,
}));

vi.mock('../../WorkspaceSwitcher', () => ({
  default: () => <div data-testid="workspace-switcher" />,
}));

vi.mock('../../knowledge-base/KnowledgeBaseSection', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="kb-embedded" data-embedded={String(Boolean(embedded))}>
      知识库内容
    </div>
  ),
}));

vi.mock('../../GatewayItem', () => ({
  default: ({ gateway }: { gateway: { name: string } }) => <li data-testid="gateway-item">{gateway.name}</li>,
}));

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'sess-1',
    userId: 'u-1',
    controllerId: 'ctrl-1',
    controllerName: '主控机',
    acpServerType: 'opencode',
    status: 'running',
    title: '开发会话',
    externalSessionId: null,
    cwd: '/repo/app',
    worktreePath: null,
    worktreeBranch: null,
    archived: false,
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T01:00:00Z',
    endedAt: null,
    ...overrides,
  };
}

function makeInstance(overrides: Partial<WorkflowInstanceSummaryData> = {}): WorkflowInstanceSummaryData {
  return {
    id: 'wf-1',
    configuredWorkflowId: null,
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: '发布流程',
    currentNodeNames: ['构建'],
    lastNodeName: null,
    lastNodeStatus: null,
    archived: false,
    workspace: { id: 'ws-1', name: 'z-agent-gear' },
    controller: { id: 'ctrl-1', name: '主控机' },
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T01:00:00Z',
    ...overrides,
  };
}

function makeHomeData(overrides: Partial<HomeOverviewData> = {}): HomeOverviewData {
  return {
    controllers: [
      {
        id: 'ctrl-1',
        name: '主控机',
        hostname: 'host-1',
        type: 'local',
        status: 'online',
        keyId: 'key-1',
        version: '2.0.0',
        lastHeartbeatAt: null,
        createdAt: '',
        updatedAt: '',
        gateways: { gateways: [{ id: 'gw-1', name: 'Web 端口', port: 3000, status: 'running' } as never], total: 1, limit: 5 },
      },
    ],
    sessions: [
      makeSession({ id: 'sess-1', title: '重构侧边栏' }),
      makeSession({ id: 'sess-2', title: '' }),
    ],
    sessionTotalCount: 2,
    workspaces: [
      {
        id: 'ws-1',
        userId: 'u-1',
        controllerId: 'ctrl-1',
        name: 'z-agent-gear',
        path: '/repo/app',
        isEnabled: true,
        isGitRepo: true,
        createdAt: '',
        updatedAt: '',
        worktrees: [],
      },
    ],
    workflowInstances: [
      makeInstance({ id: 'wf-1', name: 'UI 重构流水线' }),
      makeInstance({ id: 'wf-2', name: '接口性能压测' }),
    ],
    todos: [],
    unreadTodoCount: 0,
    sessionReviews: [],
    configuredWorkflows: [],
    workflowTemplates: [],
    workspaceContext: { myWorkspaces: [], myTenants: [] },
    ...overrides,
  };
}

describe('ContextPanel 领域聚焦侧边栏（T-SIDEBAR-2~6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseHomeOverview.mockReturnValue({
      data: makeHomeData(),
      loading: false,
      error: undefined,
      refetch: vi.fn(),
    });
    mockUseQuery.mockImplementation((_doc: unknown, options?: { skip?: boolean }) => {
      if (options?.skip) {
        return { data: undefined, loading: false, error: undefined, refetch: vi.fn() };
      }
      return {
        data: {
          cloudHostCapabilities: { enabled: true, supportedHarnesses: ['OPENCODE'] },
          sessions: [makeSession({ id: 'sess-arch', title: '历史归档会话', archived: true })],
          workflowInstances: [makeInstance({ id: 'wf-arch', name: '历史归档流程', archived: true })],
        },
        loading: false,
        error: undefined,
        refetch: vi.fn(),
      };
    });
  });

  it('T-SIDEBAR-2: 一次仅渲染当前激活领域的专属视图，不堆叠其余领域手风琴', () => {
    const { rerender } = render(<Sidebar name="tester" activeDomain="sessions" />);
    expect(screen.getByTestId('context-panel-domain-sessions')).toBeInTheDocument();
    expect(screen.queryByTestId('context-panel-domain-workflows')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-panel-domain-hosts')).not.toBeInTheDocument();

    rerender(<Sidebar name="tester" activeDomain="workflows" />);
    expect(screen.getByTestId('context-panel-domain-workflows')).toBeInTheDocument();
    expect(screen.queryByTestId('context-panel-domain-sessions')).not.toBeInTheDocument();

    rerender(<Sidebar name="tester" activeDomain="knowledgeBases" />);
    expect(screen.getByTestId('context-panel-domain-knowledgeBases')).toBeInTheDocument();
    expect(screen.getByTestId('kb-embedded')).toHaveAttribute('data-embedded', 'true');

    rerender(<Sidebar name="tester" activeDomain="hosts" />);
    expect(screen.getByTestId('context-panel-domain-hosts')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-gateway-list')).toHaveTextContent('Web 端口');
  });

  it('T-SIDEBAR-4: 会话与工作流本地筛选即时生效，空标题回退中文「未命名会话」，无匹配提供清空筛选', () => {
    render(<Sidebar name="tester" activeDomain="sessions" />);

    expect(screen.getByText('重构侧边栏')).toBeInTheDocument();
    expect(screen.getByText('未命名会话')).toBeInTheDocument();
    expect(screen.queryByText('New Session')).not.toBeInTheDocument();

    const filterInput = screen.getByTestId('context-panel-filter');
    fireEvent.change(filterInput, { target: { value: '重构' } });
    expect(screen.getByText('重构侧边栏')).toBeInTheDocument();
    expect(screen.queryByText('未命名会话')).not.toBeInTheDocument();

    fireEvent.change(filterInput, { target: { value: '不存在的关键词' } });
    expect(screen.getByText('未找到匹配的会话')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '清空筛选' })[1]);
    expect(screen.getByText('重构侧边栏')).toBeInTheDocument();
  });

  it('T-SIDEBAR-5: 已归档分组默认折叠、无计数，点击展开后按需加载归档条目', () => {
    render(<Sidebar name="tester" activeDomain="sessions" />);

    const archivedBtn = screen.getByRole('button', { name: '已归档' });
    expect(archivedBtn).toHaveAttribute('aria-expanded', 'false');
    expect(archivedBtn.textContent).toBe('已归档');
    expect(screen.queryByText('历史归档会话')).not.toBeInTheDocument();

    fireEvent.click(archivedBtn);
    expect(archivedBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('历史归档会话')).toBeInTheDocument();
  });

  it('T-SIDEBAR-6: 桌面端底栏移除重复的费用/设置/新建会话按钮；移动端保留费用/设置直达与领域切换标签', () => {
    const { rerender } = render(<Sidebar name="tester" activeDomain="sessions" />);
    const footer = screen.getByTestId('context-panel-footer');
    expect(footer).toHaveTextContent('tester');
    expect(footer.querySelector('a[href="/billing"]')).toBeNull();
    expect(footer.querySelector('a[href="/settings"]')).toBeNull();

    rerender(<Sidebar name="tester" activeDomain="sessions" mobile />);
    expect(screen.getByTestId('mobile-domain-tabs')).toBeInTheDocument();
    const mobileFooter = screen.getByTestId('context-panel-footer');
    expect(mobileFooter.querySelector('a[href="/billing"]')).not.toBeNull();
    expect(mobileFooter.querySelector('a[href="/settings"]')).not.toBeNull();
  });
});
