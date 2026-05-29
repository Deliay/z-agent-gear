import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TodoListPanel } from './TodoListPanel';

const mockRefetch = vi.fn();
const mockMarkAllTodoRead = vi.fn().mockResolvedValue({});

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

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({
    data: { getUnreadTodoCount: 3, getTodoList: defaultTodos },
    refetch: mockRefetch,
  })),
  useMutation: vi.fn(() => [mockMarkAllTodoRead]),
}));

describe('TodoListPanel', () => {
  beforeEach(() => {
    mockMarkAllTodoRead.mockClear();
    mockRefetch.mockClear();
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
    const blueDots = document.querySelectorAll('.bg-blue-500');
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
});
