import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TodoListPanel } from './TodoListPanel';
import { openElicitationDialog } from '../stores/elicitationDialog';
import { resetElicitationDialog } from '../stores/elicitationDialog';

const mockRefetch = vi.fn();
const mockMarkAllTodoRead = vi.fn().mockResolvedValue({});
const mockUseHomeOverview = vi.fn();

const defaultTodos = [
  {
    id: 'todo-1',
    type: 'permission_request',
    priority: 'urgent',
    title: 'Agent请求权限审批',
    description: '工具调用 tc-1 请求权限',
    isRead: false,
    data: {
      requestId: 'req-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      options: [
        { optionId: 'opt-1', name: '允许一次', kind: 'allow_once' },
      ],
    },
    createdAt: '2026-05-28T10:00:00.000Z',
  },
  {
    id: 'todo-2',
    type: 'permission_request',
    priority: 'medium',
    title: '普通待办',
    description: null,
    isRead: true,
    data: null,
    createdAt: '2026-05-28T09:00:00.000Z',
  },
];

function mockOverview(todos: unknown[], unreadTodoCount = 3) {
  mockUseHomeOverview.mockReturnValue({
    data: { todos, unreadTodoCount },
    loading: false,
    error: undefined,
    refetch: mockRefetch,
  });
}

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [mockMarkAllTodoRead]),
  // PermissionDialog 内部仍使用 useQuery；给出空实现即可
  useQuery: vi.fn(() => ({ data: undefined, loading: false, refetch: vi.fn() })),
}));

vi.mock('../stores/homeOverview', () => ({
  useHomeOverview: () => mockUseHomeOverview(),
}));

describe('TodoListPanel', () => {
  beforeEach(() => {
    mockMarkAllTodoRead.mockClear();
    mockRefetch.mockClear();
    resetElicitationDialog();
    mockOverview(defaultTodos);
  });

  it('should render bell icon button', () => {
    render(<TodoListPanel />);
    expect(screen.getByLabelText('待办事项')).toBeDefined();
  });

  it('should display unread count badge', () => {
    render(<TodoListPanel />);
    expect(screen.getByText('3')).toBeDefined();
  });

  it('should open popover on click', () => {
    render(<TodoListPanel />);
    fireEvent.click(screen.getByLabelText('待办事项'));
    expect(screen.getByText('待办事项')).toBeDefined();
    expect(screen.getByText('全部已读')).toBeDefined();
  });

  it('should display todo items in popover', () => {
    render(<TodoListPanel />);
    fireEvent.click(screen.getByLabelText('待办事项'));
    expect(screen.getByText('Agent请求权限审批')).toBeDefined();
    expect(screen.getByText('普通待办')).toBeDefined();
  });

  it('should display unread indicator for unread todos', () => {
    render(<TodoListPanel />);
    fireEvent.click(screen.getByLabelText('待办事项'));
    const blueDots = document.querySelectorAll('.bg-info');
    expect(blueDots.length).toBe(1);
  });

  it('should open PermissionDialog when clicking a permission_request todo', () => {
    render(<TodoListPanel />);
    fireEvent.click(screen.getByLabelText('待办事项'));
    fireEvent.click(screen.getByText('Agent请求权限审批'));
    expect(screen.getByText('工具调用 ID')).toBeDefined();
  });

  it('should not open dialog for non-permission todos', () => {
    render(<TodoListPanel />);
    fireEvent.click(screen.getByLabelText('待办事项'));
    fireEvent.click(screen.getByText('普通待办'));
    expect(screen.queryByText('工具调用 ID')).toBeNull();
  });

  it('should call markAllTodoRead when clicking mark all read button', async () => {
    render(<TodoListPanel />);
    fireEvent.click(screen.getByLabelText('待办事项'));
    fireEvent.click(screen.getByText('全部已读'));
    await waitFor(() => {
      expect(mockMarkAllTodoRead).toHaveBeenCalled();
    });
  });

  describe('elicitation_request todos', () => {
    const elicitationTodo = {
      id: 'todo-e1',
      type: 'elicitation_request',
      priority: 'immediate',
      title: 'Agent请求补充信息',
      description: null,
      isRead: false,
      data: null,
      elicitationData: {
        requestId: 'el-req-1',
        sessionId: 'sess-1',
        toolCallId: 'tc-1',
        mode: 'form' as const,
        message: '请确认发布配置',
        requestedSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
        elicitationId: 'el-1',
        url: null,
      },
      createdAt: '2026-05-28T11:00:00.000Z',
    };

    it('should auto-open ElicitationDialog for immediate unread elicitation_request todo', async () => {
      mockOverview([elicitationTodo]);
      render(<TodoListPanel />);
      await waitFor(() => {
        expect(screen.getByText('请确认发布配置')).toBeDefined();
      });
      expect(screen.getByText('提交')).toBeDefined();
    });

    it('should show type badge for elicitation_request todo in popover', () => {
      mockOverview([elicitationTodo]);
      render(<TodoListPanel />);
      fireEvent.click(screen.getByLabelText('待办事项'));
      expect(screen.getByText('信息请求')).toBeDefined();
    });

    it('should open ElicitationDialog when clicking an elicitation_request todo', async () => {
      const nonImmediate = { ...elicitationTodo, id: 'todo-e2', priority: 'urgent' };
      mockOverview([nonImmediate]);
      render(<TodoListPanel />);
      fireEvent.click(screen.getByLabelText('待办事项'));
      fireEvent.click(screen.getByText('Agent请求补充信息'));
      await waitFor(() => {
        expect(screen.getByText('请确认发布配置')).toBeDefined();
      });
    });
  });
});

describe('TodoListPanel - 弹窗状态机', () => {
  beforeEach(() => {
    resetElicitationDialog();
  });

  const makeElicitation = (id: string, requestId: string, message: string) => ({
    id,
    type: 'elicitation_request',
    priority: 'immediate',
    title: 'Agent请求输入',
    description: null,
    isRead: false,
    data: null,
    elicitationData: {
      requestId,
      sessionId: 'sess-1',
      toolCallId: null,
      mode: 'form' as const,
      message,
      requestedSchema: { type: 'object' as const, properties: {} },
      elicitationId: null,
      url: null,
    },
    createdAt: '2026-10-21T00:00:00.000Z',
  });

  it('R2-1: owner=banner 持 stale 快照时同样放行后续 immediate 自动弹窗', async () => {
    const stale = makeElicitation('todo-stale', 'elic-stale', 'Stale input');
    openElicitationDialog(stale, 'banner');
    mockOverview([makeElicitation('todo-new', 'elic-new', 'New immediate')]);

    render(<TodoListPanel />);

    await waitFor(() => expect(screen.getByText('New immediate')).toBeDefined());
  });

  it('R2-2: StrictMode 双挂载下首条 immediate 自动弹窗不丢失', async () => {
    mockOverview([makeElicitation('todo-sm', 'elic-sm', 'Strict input')]);

    render(
      <StrictMode>
        <TodoListPanel />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByText('Strict input')).toBeDefined());
    // 再等一轮 effect/cleanup，确认不会被 StrictMode 的 cleanup 关闭
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('Strict input')).toBeDefined();
  });

  it('N-6: 已 accepted 的问询被移除后仍展示终态（而非已失效）', async () => {
    const todo = makeElicitation('todo-term', 'elic-term', 'Terminal input');
    mockOverview([todo]);
    const { rerender } = render(<TodoListPanel />);
    await waitFor(() => expect(screen.getByText('Terminal input')).toBeDefined());

    mockOverview([{ ...todo, resolution: 'accepted' }]);
    rerender(<TodoListPanel />);
    await waitFor(() => expect(screen.getByTestId('elicitation-status').textContent).toContain('已提交'));

    mockOverview([]);
    rerender(<TodoListPanel />);
    await waitFor(() => expect(screen.getByTestId('elicitation-status').textContent).toContain('已提交'));
    expect(screen.getByTestId('elicitation-status').textContent).not.toContain('已从待办移除');
  });

  it('N6: todo 被移除后不残留 id 阻塞后续 immediate 问询自动弹窗', async () => {
    // 首条 immediate 自动弹窗
    mockOverview([makeElicitation('todo-a', 'elic-a', 'First input')]);
    const { rerender } = render(<TodoListPanel />);
    await waitFor(() => expect(screen.getByText('First input')).toBeDefined());

    // 被 TTL 删除且未 resolved：弹窗以「已失效」收敛
    mockOverview([]);
    rerender(<TodoListPanel />);
    await waitFor(() => expect(screen.getByTestId('elicitation-status').textContent).toContain('已从待办移除'));

    // 新 immediate 问询仍必须能自动弹出（不被残留 id 永久跳过）
    mockOverview([makeElicitation('todo-b', 'elic-b', 'Second input')]);
    rerender(<TodoListPanel />);
    await waitFor(() => expect(screen.getByText('Second input')).toBeDefined());
  });
});

describe('TodoListPanel - resolved elicitation', () => {
  beforeEach(() => {
    resetElicitationDialog();
  });

  it('T-W17: 已 resolved 的问询不触发自动弹窗', async () => {
    mockOverview([
      {
        id: 'todo-e1',
        type: 'elicitation_request',
        priority: 'immediate',
        title: 'Agent请求输入：已过期问询',
        description: 'Need input',
        isRead: false,
        data: null,
        elicitationData: {
          requestId: 'elic-resolved',
          sessionId: 'sess-1',
          toolCallId: null,
          mode: 'form',
          message: 'Need input',
          requestedSchema: { type: 'object', properties: { a: { type: 'string' } } },
          elicitationId: null,
          url: null,
        },
        resolution: 'expired',
        resolvedAt: '2026-10-21T00:00:00.000Z',
        createdAt: '2026-10-21T00:00:00.000Z',
      },
    ]);

    render(<TodoListPanel />);
    await waitFor(() => {
      expect(screen.queryByText('Agent请求输入：已过期问询')).toBeNull();
    });
  });
});
