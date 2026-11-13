import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PendingElicitationBanner } from '../PendingElicitationBanner';
import type { TodoItemData } from '../../../graphql/types';

/** 提示条（T-DLG9~T-DLG11）：点击改为滚动定位到会话卡片，不再打开弹窗。 */

const mockUseHomeOverview = vi.fn();

vi.mock('../../../stores/homeOverview', () => ({
  useHomeOverview: () => mockUseHomeOverview(),
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
  mockUseHomeOverview.mockReturnValue({ data: { todos, unreadTodoCount: todos.length }, refetch: vi.fn() });
}

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy as never;
  mockOverview([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PendingElicitationBanner', () => {
  it('T-DLG9: 有未解决问询时显示数量与查看按钮；无则不渲染', () => {
    mockOverview([elicitationTodo()]);
    const { unmount } = render(<PendingElicitationBanner sessionId="sess-1" />);
    expect(screen.getByTestId('pending-elicitation-banner').textContent).toContain('Agent 正在等待你的输入（1）');
    expect(screen.getByText('查看')).toBeDefined();
    unmount();

    mockOverview([]);
    render(<PendingElicitationBanner sessionId="sess-1" />);
    expect(screen.queryByTestId('pending-elicitation-banner')).toBeNull();
  });

  it('T-DLG10: 已 resolved 或属于其他会话的问询不计入', () => {
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

  it('T-DLG11: 点击「查看」滚动定位到对应 interactionId 的卡片', () => {
    mockOverview([elicitationTodo()]);
    const card = document.createElement('div');
    card.setAttribute('data-interaction-id', 'elic-1');
    card.scrollIntoView = scrollSpy as never;
    document.body.appendChild(card);

    render(<PendingElicitationBanner sessionId="sess-1" />);
    fireEvent.click(screen.getByText('查看'));

    expect(scrollSpy).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    card.remove();
  });
});
