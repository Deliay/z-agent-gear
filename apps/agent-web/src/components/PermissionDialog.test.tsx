import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PermissionDialog } from './PermissionDialog';
import type { TodoItemData } from '../graphql/types';

/** 权限通知视图（T-DLG6~T-DLG8）：不再渲染审批按钮，只跳转会话卡片。 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function permissionTodo(overrides: Partial<TodoItemData> = {}): TodoItemData {
  return {
    id: 'todo-p1',
    type: 'permission_request',
    priority: 'immediate',
    title: 'Agent请求权限：Bash: npm test',
    description: '执行命令：npm test',
    isRead: false,
    data: {
      requestId: 'perm-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      toolCall: { toolCallId: 'tc-1', title: 'Bash: npm test', kind: 'execute' },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      ],
    },
    createdAt: '2026-05-28T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('PermissionDialog - 通知视图', () => {
  it('T-DLG6: 不再渲染审批选项按钮', () => {
    render(<PermissionDialog open onOpenChange={vi.fn()} todo={permissionTodo()} />);
    expect(screen.getByTestId('permission-notice')).toBeDefined();
    expect(screen.queryByText('Allow once')).toBeNull();
    expect(screen.queryByText('Reject once')).toBeNull();
  });

  it('T-DLG7: 展示工具调用摘要与剩余时限提示', () => {
    render(<PermissionDialog open onOpenChange={vi.fn()} todo={permissionTodo()} />);
    expect(screen.getByText('执行命令：npm test')).toBeDefined();
    expect(screen.getByText(/约 1 分钟后过期/)).toBeDefined();
  });

  it('T-DLG8: 点击「前往会话处理」导航到审批卡片锚点并关闭弹窗', () => {
    const onOpenChange = vi.fn();
    render(<PermissionDialog open onOpenChange={onOpenChange} todo={permissionTodo()} />);

    fireEvent.click(screen.getByText('前往会话处理'));

    expect(mockNavigate).toHaveBeenCalledWith('/sessions/sess-1#interaction-perm-1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
