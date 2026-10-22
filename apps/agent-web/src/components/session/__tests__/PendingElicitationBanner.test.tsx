import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PendingElicitationBanner } from '../PendingElicitationBanner';
import { resetElicitationDialog } from '../../../stores/elicitationDialog';
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
    resetElicitationDialog();
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

  it('T-W14b: 弹窗打开后 pending 变空（轮询标 expired）仍保留弹窗并展示终态', () => {
    mockOverview([elicitationTodo()]);
    const { rerender } = render(<PendingElicitationBanner sessionId="sess-1" />);
    fireEvent.click(screen.getByText('查看'));
    expect(screen.getByText('提交')).toBeDefined();

    // 轮询拿到 resolution：入口消失，但弹窗不得连同表单一起被卸载
    mockOverview([elicitationTodo({ resolution: 'expired' })]);
    rerender(<PendingElicitationBanner sessionId="sess-1" />);

    expect(screen.queryByTestId('pending-elicitation-banner')).toBeNull();
    expect(screen.getByTestId('elicitation-status').textContent).toContain('该问询已过期');
    expect(screen.queryByText('提交')).toBeNull();
  });

  it('T-W14d: 打开后 todo 被 TTL/limit 移除仍保留弹窗并展示已失效终态', () => {
    mockOverview([elicitationTodo()]);
    const { rerender } = render(<PendingElicitationBanner sessionId="sess-1" />);
    fireEvent.click(screen.getByText('查看'));
    expect(screen.getByText('提交')).toBeDefined();

    // 待办从列表消失（TTL 删档）：不能连同表单一起卸载
    mockOverview([]);
    rerender(<PendingElicitationBanner sessionId="sess-1" />);

    expect(screen.getByTestId('elicitation-status').textContent).toContain('已从待办移除');
    expect(screen.queryByText('提交')).toBeNull();
  });

  it('T-W14e: 切换会话不重开他会话的问询弹窗（快照校验 sessionId）', () => {
    mockOverview([elicitationTodo()]);
    const { rerender } = render(<PendingElicitationBanner sessionId="sess-1" />);
    fireEvent.click(screen.getByText('查看'));
    expect(screen.getByText('Need input')).toBeDefined();

    mockOverview([elicitationTodo()]);
    rerender(<PendingElicitationBanner sessionId="sess-2" />);

    expect(screen.queryByText('Need input')).toBeNull();
  });

  it('T-W14c: Banner 与全局待办面板共享打开权（同一时刻只可能一个弹窗）', async () => {
    mockOverview([elicitationTodo()]);
    const { TodoListPanel } = await import('../../TodoListPanel');
    render(
      <>
        <PendingElicitationBanner sessionId="sess-1" />
        <TodoListPanel />
      </>,
    );

    // 全局面板自动弹窗（owner=todo）后，Banner 点击切换 owner 不会产生第二个弹窗
    await screen.findByText('Agent请求输入：填写信息');
    expect(screen.getAllByText('Need input')).toHaveLength(1);

    fireEvent.click(screen.getByText('查看'));
    expect(screen.getAllByText('Need input')).toHaveLength(1);
  });
});
