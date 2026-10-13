import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TodoListPanel } from './TodoListPanel';

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
      expect(mockRefetch).toHaveBeenCalled();
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
