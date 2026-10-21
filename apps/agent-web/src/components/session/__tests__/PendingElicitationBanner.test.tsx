import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PendingElicitationBanner } from '../PendingElicitationBanner';
import type { TodoItemData } from '../../../graphql/types';

const mockRefetch = vi.fn();
const mockUseHomeOverview = vi.fn();

vi.mock('../../../stores/homeOverview', () => ({
  useHomeOverview: () => mockUseHomeOverview(),
}));

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [vi.fn()]),
}));

function elicitationTodo(overrides: Partial<TodoItemData> = {}): TodoItemData {
  return {
    id: 'todo-1',
    type: 'elicitation_request',
    priority: 'immediate',
    title: 'Agent请求输入：填写信息',
    description: 'Need input',
    isRead: false,
    data: null,
    elicitationData: {
      requestId: 'elic-1',
      sessionId: 'sess-1',
      mode: 'form',
      message: 'Need input',
      requestedSchema: {
        type: 'object',
        properties: { answer: { type: 'string', title: 'Answer' } },
      },
    },
    resolution: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

function mockOverview(todos: TodoItemData[]) {
  mockUseHomeOverview.mockReturnValue({ data: { todos, unreadTodoCount: todos.length }, refetch: mockRefetch });
}

describe('PendingElicitationBanner', () => {
  beforeEach(() => {
    mockRefetch.mockClear();
  });

  it('T-W13: 有未解决问询时显示数量与查看按钮；无则不渲染', () => {
    mockOverview([elicitationTodo()]);
    const { unmount } = render(<PendingElicitationBanner sessionId="sess-1" />);
    expect(screen.getByTestId('pending-elicitation-banner').textContent).toContain('Agent 正在等待你的输入（1）');
    expect(screen.getByText('查看')).toBeDefined();
    unmount();

    mockOverview([]);
    render(<PendingElicitationBanner sessionId="sess-1" />);
    expect(screen.queryByTestId('pending-elicitation-banner')).toBeNull();
  });

  it('已 resolved 或属于其他会话的问询不计入', () => {
    mockOverview([
      elicitationTodo({ resolution: 'expired' }),
      elicitationTodo({
        id: 'todo-2',
        elicitationData: { ...elicitationTodo().elicitationData!, sessionId: 'sess-2' },
      }),
    ]);
    render(<PendingElicitationBanner sessionId="sess-1" />);
    expect(screen.queryByTestId('pending-elicitation-banner')).toBeNull();
  });

  it('T-W14: 点击查看打开 ElicitationDialog 并承载该 todo', () => {
    mockOverview([elicitationTodo()]);
    render(<PendingElicitationBanner sessionId="sess-1" />);

    fireEvent.click(screen.getByText('查看'));

    expect(screen.getByText('Agent请求输入：填写信息')).toBeDefined();
    expect(screen.getByText('Need input')).toBeDefined();
    expect(screen.getByText('提交')).toBeDefined();
  });
});
