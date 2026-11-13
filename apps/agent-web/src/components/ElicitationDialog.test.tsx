import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ElicitationDialog } from './ElicitationDialog';
import type { TodoItemData } from '../graphql/types';

/**
 * 通知视图（T-DLG1~T-DLG4）：表单与作答按钮已迁到会话时间线 InteractionCard，
 * 弹窗只展示摘要 + 剩余时限提示 + 「前往会话处理」（跳转并带上卡片锚点）。
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function elicitationTodo(overrides: Partial<TodoItemData> = {}): TodoItemData {
  return {
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
      mode: 'form',
      message: '请确认发布配置\n第二行不应展示',
      requestedSchema: {
        type: 'object',
        properties: { environment: { type: 'string', title: '目标环境' } },
        required: ['environment'],
      },
      elicitationId: 'el-1',
      url: null,
    },
    resolution: null,
    createdAt: '2026-05-28T10:00:00.000Z',
    ...overrides,
  };
}

function renderDialog(todo: TodoItemData, props: { stale?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  return render(
    <MemoryRouter>
      <ElicitationDialog
        open
        todo={todo}
        stale={props.stale}
        onOpenChange={props.onOpenChange ?? vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('ElicitationDialog - 通知视图', () => {
  it('T-DLG1: 不再渲染表单字段与提交/拒绝/取消按钮', () => {
    renderDialog(elicitationTodo());
    expect(screen.getByTestId('elicitation-notice')).toBeDefined();
    expect(screen.queryByText('提交')).toBeNull();
    expect(screen.queryByText('拒绝')).toBeNull();
    expect(screen.queryByText('取消')).toBeNull();
    expect(screen.queryByLabelText('目标环境')).toBeNull();
  });

  it('T-DLG2: 摘要只展示首行 + 剩余时限提示 + 跳转主按钮', () => {
    renderDialog(elicitationTodo());
    expect(screen.getByText('请确认发布配置')).toBeDefined();
    expect(screen.queryByText('第二行不应展示')).toBeNull();
    expect(screen.getByText(/约 1 分钟后过期/)).toBeDefined();
    expect(screen.getByText('前往会话处理')).toBeDefined();
  });

  it('T-DLG3: 点击「前往会话处理」导航到会话卡片锚点并关闭弹窗', () => {
    const onOpenChange = vi.fn();
    renderDialog(elicitationTodo(), { onOpenChange });

    fireEvent.click(screen.getByText('前往会话处理'));

    expect(mockNavigate).toHaveBeenCalledWith('/sessions/sess-1#interaction-el-req-1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('T-DLG4: 终态/失效仍展示状态文案（便于通知回看）', () => {
    renderDialog(elicitationTodo({ resolution: 'accepted' }));
    expect(screen.getByTestId('elicitation-status').textContent).toContain('已提交');
  });

  it('T-DLG5: stale（已从待办移除）展示已失效', () => {
    renderDialog(elicitationTodo(), { stale: true });
    expect(screen.getByTestId('elicitation-status').textContent).toContain('已失效');
  });
});
