import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ElicitationDialog } from './ElicitationDialog';

const mockRespondElicitation = vi.fn().mockResolvedValue({});

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [mockRespondElicitation]),
}));

describe('ElicitationDialog', () => {
  const formTodo = {
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
        title: '发布配置',
        properties: {
          environment: {
            type: 'string',
            title: '目标环境',
            enum: ['staging', 'production'],
          },
          notes: {
            type: 'string',
            title: '备注',
            default: '默认备注',
            maxLength: 50,
          },
          confirmed: {
            type: 'boolean',
            title: '我已确认',
          },
        },
        required: ['environment'],
      },
      elicitationId: 'el-1',
      url: null,
    },
    createdAt: '2026-05-28T10:00:00.000Z',
  };

  const urlTodo = {
    ...formTodo,
    id: 'todo-e2',
    elicitationData: {
      requestId: 'el-req-2',
      sessionId: 'sess-1',
      toolCallId: null,
      mode: 'url' as const,
      message: '需要打开外部页面完成授权',
      requestedSchema: null,
      elicitationId: 'el-2',
      url: 'https://auth.example.com/authorize?state=abc',
    },
  };

  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    todo: formTodo,
  };

  beforeEach(() => {
    mockRespondElicitation.mockClear();
    mockRespondElicitation.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('form mode', () => {
    it('should render message', () => {
      render(<ElicitationDialog {...defaultProps} />);
      expect(screen.getByText('请确认发布配置')).toBeDefined();
    });

    it('should render enum string field as radio group', () => {
      render(<ElicitationDialog {...defaultProps} />);
      const group = screen.getByRole('radiogroup', { name: '目标环境' });
      expect(group).toBeDefined();
      expect(screen.getByLabelText('staging')).toBeDefined();
      expect(screen.getByLabelText('production')).toBeDefined();
    });

    it('should render boolean field as checkbox', () => {
      render(<ElicitationDialog {...defaultProps} />);
      expect(screen.getByRole('checkbox')).toBeDefined();
    });

    it('should prefill default value', () => {
      render(<ElicitationDialog {...defaultProps} />);
      const input = screen.getByLabelText('备注') as HTMLInputElement;
      expect(input.value).toBe('默认备注');
    });

    it('should disable submit and show hint when required field is missing', () => {
      render(<ElicitationDialog {...defaultProps} />);
      const submitBtn = screen.getByText('提交') as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(true);
      expect(screen.getByText(/请填写必填项：目标环境/)).toBeDefined();
    });

    it('should submit form values with accept action', async () => {
      render(<ElicitationDialog {...defaultProps} />);
      fireEvent.click(screen.getByLabelText('production'));
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByText('提交'));
      await waitFor(() => {
        expect(mockRespondElicitation).toHaveBeenCalledWith({
          variables: {
            requestId: 'el-req-1',
            action: 'accept',
            values: {
              environment: 'production',
              notes: '默认备注',
              confirmed: true,
            },
          },
        });
      });
    });

    it('should send decline action with null values', async () => {
      render(<ElicitationDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('拒绝'));
      await waitFor(() => {
        expect(mockRespondElicitation).toHaveBeenCalledWith({
          variables: {
            requestId: 'el-req-1',
            action: 'decline',
            values: null,
          },
        });
      });
    });

    it('should send cancel action with null values', async () => {
      render(<ElicitationDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('取消'));
      await waitFor(() => {
        expect(mockRespondElicitation).toHaveBeenCalledWith({
          variables: {
            requestId: 'el-req-1',
            action: 'cancel',
            values: null,
          },
        });
      });
    });

    it('should close dialog and call onResponded after successful response', async () => {
      const onOpenChange = vi.fn();
      const onResponded = vi.fn();
      render(
        <ElicitationDialog {...defaultProps} onOpenChange={onOpenChange} onResponded={onResponded} />,
      );
      fireEvent.click(screen.getByText('拒绝'));
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onResponded).toHaveBeenCalled();
      });
    });
  });

  describe('url mode', () => {
    const urlProps = { ...defaultProps, todo: urlTodo };

    it('should render message and url with highlighted host', () => {
      render(<ElicitationDialog {...urlProps} />);
      expect(screen.getByText('需要打开外部页面完成授权')).toBeDefined();
      expect(screen.getByText('auth.example.com')).toBeDefined();
      expect(screen.getByText('/authorize?state=abc')).toBeDefined();
    });

    it('should open url in new tab and submit accept on open link click', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      render(<ElicitationDialog {...urlProps} />);
      fireEvent.click(screen.getByText('打开链接'));
      expect(openSpy).toHaveBeenCalledWith(
        'https://auth.example.com/authorize?state=abc',
        '_blank',
        'noopener,noreferrer',
      );
      await waitFor(() => {
        expect(mockRespondElicitation).toHaveBeenCalledWith({
          variables: {
            requestId: 'el-req-2',
            action: 'accept',
            values: null,
          },
        });
      });
    });

    it('should send decline action in url mode', async () => {
      render(<ElicitationDialog {...urlProps} />);
      fireEvent.click(screen.getByText('拒绝'));
      await waitFor(() => {
        expect(mockRespondElicitation).toHaveBeenCalledWith({
          variables: {
            requestId: 'el-req-2',
            action: 'decline',
            values: null,
          },
        });
      });
    });
  });

  it('should not render if todo.elicitationData is null', () => {
    const todoWithoutData = { ...formTodo, elicitationData: null };
    const { container } = render(
      <ElicitationDialog {...defaultProps} todo={todoWithoutData} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
