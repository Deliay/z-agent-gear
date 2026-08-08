import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useQuery } from '@apollo/client/react';
import { PermissionDialog } from './PermissionDialog';

const mockUseQuery = useQuery as unknown as ReturnType<typeof vi.fn>;

const mockRespondPermission = vi.fn().mockResolvedValue({});

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [mockRespondPermission]),
  useQuery: vi.fn(() => ({ data: { sessionMessages: [] } })),
}));

describe('PermissionDialog', () => {
  const baseTodo = {
    id: 'todo-1',
    type: 'permission_request',
    priority: 'immediate',
    title: 'Agent请求权限审批',
    description: 'Agent请求删除文件',
    isRead: false,
    data: {
      requestId: 'req-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-123',
      options: [
        { optionId: 'opt-1', name: '允许一次', kind: 'allow_once' },
        { optionId: 'opt-2', name: '始终允许', kind: 'allow_always' },
        { optionId: 'opt-3', name: '拒绝', kind: 'reject_once' },
      ],
    },
    createdAt: '2026-05-28T10:00:00.000Z',
  };

  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    todo: baseTodo,
  };

  beforeEach(() => {
    mockRespondPermission.mockClear();
    mockRespondPermission.mockResolvedValue({});
  });

  it('should render dialog title', () => {
    render(<PermissionDialog {...defaultProps} />);
    expect(screen.getByText('Agent请求权限审批')).toBeDefined();
  });

  it('should render description', () => {
    render(<PermissionDialog {...defaultProps} />);
    expect(screen.getByText('Agent请求删除文件')).toBeDefined();
  });

  it('should render tool call ID', () => {
    render(<PermissionDialog {...defaultProps} />);
    expect(screen.getByText('tc-123')).toBeDefined();
  });

  it('should render all permission options', () => {
    render(<PermissionDialog {...defaultProps} />);
    expect(screen.getByText('允许一次')).toBeDefined();
    expect(screen.getByText('始终允许')).toBeDefined();
    expect(screen.getByText('拒绝')).toBeDefined();
  });

  it('should render cancel button', () => {
    render(<PermissionDialog {...defaultProps} />);
    expect(screen.getByText('取消')).toBeDefined();
  });

  it('should call respondPermission with selected option', async () => {
    render(<PermissionDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('允许一次'));
    await waitFor(() => {
      expect(mockRespondPermission).toHaveBeenCalledWith({
        variables: {
          requestId: 'req-1',
          outcome: 'selected',
          optionId: 'opt-1',
        },
      });
    });
  });

  it('should call respondPermission with cancelled outcome on cancel', async () => {
    render(<PermissionDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('取消'));
    await waitFor(() => {
      expect(mockRespondPermission).toHaveBeenCalledWith({
        variables: {
          requestId: 'req-1',
          outcome: 'cancelled',
          optionId: undefined,
        },
      });
    });
  });

  it('should close dialog after successful response', async () => {
    const onOpenChange = vi.fn();
    render(<PermissionDialog {...defaultProps} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText('允许一次'));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('should not render if todo.data is null', () => {
    const todoWithoutData = { ...baseTodo, data: null };
    const { container } = render(
      <PermissionDialog {...defaultProps} todo={todoWithoutData} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('should disable buttons while responding', async () => {
    mockRespondPermission.mockImplementation(() => new Promise(() => {}));
    render(<PermissionDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('允许一次'));
    await waitFor(() => {
      expect((screen.getByText('允许一次') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText('取消') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('should use destructive variant for reject options', () => {
    render(<PermissionDialog {...defaultProps} />);
    const rejectBtn = screen.getByText('拒绝');
    expect(rejectBtn.className).toContain('bg-destructive');
  });

  it('should use default variant for allow options', () => {
    render(<PermissionDialog {...defaultProps} />);
    const allowBtn = screen.getByText('允许一次');
    expect(allowBtn.className).toContain('bg-primary');
  });

  describe('toolCall detail from todo.data', () => {
    const todoWithToolCall = {
      ...baseTodo,
      data: {
        ...baseTodo.data,
        toolCall: {
          toolCallId: 'tc-123',
          title: '删除临时文件',
          kind: 'delete',
          rawInput: { filePath: '/tmp/cache.txt' },
          locations: [{ path: '/tmp/cache.txt', line: 12 }],
        },
      },
    };

    it('should render tool call details directly when toolCall has title/rawInput', () => {
      render(<PermissionDialog {...defaultProps} todo={todoWithToolCall} />);
      expect(screen.getByText('删除临时文件')).toBeDefined();
      expect(screen.getByText('delete')).toBeDefined();
      // 参数摘要（文件路径）与 locations 列表
      expect(screen.getAllByText('/tmp/cache.txt').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('/tmp/cache.txt:12')).toBeDefined();
      // 不再展示裸 toolCallId 兜底
      expect(screen.queryByText('工具调用 ID')).toBeNull();
    });

    it('should skip session messages query when toolCall detail is available', () => {
      mockUseQuery.mockClear();
      render(<PermissionDialog {...defaultProps} todo={todoWithToolCall} />);
      expect(mockUseQuery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skip: true }),
      );
    });

    it('should render command summary for execute kind', () => {
      const todoWithExecute = {
        ...baseTodo,
        data: {
          ...baseTodo.data,
          toolCall: {
            toolCallId: 'tc-123',
            title: '运行测试',
            kind: 'execute',
            rawInput: { command: 'npm run test' },
          },
        },
      };
      render(<PermissionDialog {...defaultProps} todo={todoWithExecute} />);
      expect(screen.getByText('npm run test')).toBeDefined();
    });

    it('should fall back to session messages lookup when toolCall has no detail', () => {
      mockUseQuery.mockClear();
      const todoWithoutDetail = {
        ...baseTodo,
        data: {
          ...baseTodo.data,
          toolCall: { toolCallId: 'tc-123' },
        },
      };
      render(<PermissionDialog {...defaultProps} todo={todoWithoutDetail} />);
      // 未跳过查询且走原有 toolCallId 兜底展示
      expect(mockUseQuery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skip: false }),
      );
      expect(screen.getByText('tc-123')).toBeDefined();
    });
  });
});
