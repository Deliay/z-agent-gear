import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ElicitationDialog } from './ElicitationDialog';
import { joinMultiSelectValues } from '../lib/elicitation-multi-select';
import { resetElicitationDialog } from '../stores/elicitationDialog';

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
    resetElicitationDialog();
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

    it('N-8: 非 http(s) URL 不打开窗口也不回传 accept', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      render(
        <ElicitationDialog
          {...defaultProps}
          todo={{
            ...urlTodo,
            elicitationData: { ...urlTodo.elicitationData, url: 'javascript:alert(1)' },
          }}
        />,
      );
      fireEvent.click(screen.getByText('打开链接'));

      expect(openSpy).not.toHaveBeenCalled();
      expect(mockRespondElicitation).not.toHaveBeenCalled();
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

describe('ElicitationDialog - 终态', () => {
  const baseTodo = {
    id: 'todo-e3',
    type: 'elicitation_request',
    priority: 'immediate',
    title: 'Agent请求补充信息',
    description: null,
    isRead: false,
    data: null,
    elicitationData: {
      requestId: 'el-req-3',
      sessionId: 'sess-1',
      toolCallId: null,
      mode: 'form' as const,
      message: '请确认发布配置',
      requestedSchema: { type: 'object' as const, properties: { a: { type: 'string' as const, title: 'A' } } },
      elicitationId: null,
      url: null,
    },
    createdAt: '2026-10-21T00:00:00.000Z',
  };

  it('T-W15: resolution=expired 显示已过期并隐藏操作按钮', () => {
    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={{ ...baseTodo, resolution: 'expired' }} />);
    expect(screen.getByTestId('elicitation-status').textContent).toContain('该问询已过期');
    expect(screen.queryByText('提交')).toBeNull();
    expect(screen.queryByText('拒绝')).toBeNull();
  });

  it('T-W15b: expiresAt 已过但 resolution 为空（TTL 未清理）同样按过期处理', () => {
    render(
      <ElicitationDialog
        open
        onOpenChange={vi.fn()}
        todo={{ ...baseTodo, expiresAt: new Date(Date.now() - 60_000).toISOString() }}
      />,
    );
    expect(screen.getByTestId('elicitation-status').textContent).toContain('该问询已过期');
    expect(screen.queryByText('提交')).toBeNull();
  });

  it('T-W15c: 挂载后跨过 expiresAt 立即进入已过期（now 不冻结于挂载时刻）', () => {
    vi.useFakeTimers();
    try {
      const expiresAt = new Date(Date.now() + 1_000).toISOString();
      render(
        <ElicitationDialog
          open
          onOpenChange={vi.fn()}
          todo={{ ...baseTodo, expiresAt }}
        />,
      );
      // 挂载时尚未到期：操作可用
      expect(screen.getByText('提交')).toBeDefined();
      expect(screen.queryByTestId('elicitation-status')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(1_100);
      });

      expect(screen.getByTestId('elicitation-status').textContent).toContain('该问询已过期');
      expect(screen.queryByText('提交')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('T-W19: 表单草稿跨挂载保留（owner 切换不丢已填内容）', () => {
    const { unmount } = render(
      <ElicitationDialog open onOpenChange={vi.fn()} todo={{ ...baseTodo }} />,
    );
    const input = screen.getByLabelText('A') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '半途输入' } });
    unmount();

    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={{ ...baseTodo }} />);
    expect((screen.getByLabelText('A') as HTMLInputElement).value).toBe('半途输入');
  });

  it('T-W18: stale=true（待办已从列表移除）展示已失效终态且隐藏操作', () => {
    render(
      <ElicitationDialog open stale onOpenChange={vi.fn()} todo={{ ...baseTodo }} />,
    );
    expect(screen.getByTestId('elicitation-status').textContent).toContain('已从待办移除');
    expect(screen.queryByText('提交')).toBeNull();
    expect(screen.queryByText('拒绝')).toBeNull();
  });

  it('T-W16: cancelled/failed 显示对应文案并隐藏操作', () => {
    const { unmount } = render(
      <ElicitationDialog open onOpenChange={vi.fn()} todo={{ ...baseTodo, resolution: 'cancelled' }} />,
    );
    expect(screen.getByTestId('elicitation-status').textContent).toContain('该问询已取消');
    expect(screen.queryByText('提交')).toBeNull();
    unmount();

    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={{ ...baseTodo, resolution: 'failed' }} />);
    expect(screen.getByTestId('elicitation-status').textContent).toContain('该问询已失效');
    expect(screen.queryByText('提交')).toBeNull();
  });

  it('accepted/declined 展示结果且允许关闭', () => {
    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={{ ...baseTodo, resolution: 'accepted' }} />);
    expect(screen.getByTestId('elicitation-status').textContent).toContain('该问询已提交');
    expect(screen.queryByText('提交')).toBeNull();
  });
});

describe('ElicitationDialog - 多选 anyOf', () => {
  // 真实 ACP question 工具形态：type:array + items.anyOf（无 items.enum/oneOf）
  const multiTodo = {
    id: 'todo-e4',
    type: 'elicitation_request',
    priority: 'immediate',
    title: 'Agent请求输入：实施选项',
    description: null,
    isRead: false,
    data: null,
    elicitationData: {
      requestId: 'el-req-multi',
      sessionId: 'sess-1',
      toolCallId: 'tc-multi',
      mode: 'form' as const,
      message: '请选择实施选项',
      requestedSchema: {
        type: 'object' as const,
        title: '实施选项',
        properties: {
          q0: {
            type: 'string',
            title: '实施方式',
            oneOf: [
              { const: '自动', title: '自动' },
              { const: '手动', title: '手动' },
            ],
          },
          q1: {
            type: 'array',
            title: '要做的事',
            description: '可多选',
            items: {
              anyOf: [
                { const: '自动跑测试', title: '自动跑测试', description: '提交前运行单测与 E2E' },
                { const: '生成文档', title: '生成文档' },
                { const: '部署', title: '部署' },
              ],
            },
          },
          extras: {
            type: 'array',
            title: '附加项',
            items: {
              anyOf: [
                { const: 'X', title: 'X' },
                { const: 'Y', title: 'Y' },
              ],
            },
          },
        },
        required: ['q1'],
      },
      elicitationId: null,
      url: null,
    },
    createdAt: '2026-11-04T00:00:00.000Z',
  };

  // enum/oneOf 数组 + 单选 + 自由文本的回归基线形态
  const mixedTodo = {
    ...multiTodo,
    id: 'todo-e5',
    elicitationData: {
      ...multiTodo.elicitationData,
      requestId: 'el-req-mixed',
      requestedSchema: {
        type: 'object' as const,
        title: '混合表单',
        properties: {
          envs: { type: 'array', title: '环境', items: { enum: ['dev', 'prod'] } },
          stages: {
            type: 'array',
            title: '阶段',
            items: {
              oneOf: [
                { const: 's1', title: '阶段一' },
                { const: 's2', title: '阶段二' },
              ],
            },
          },
          target: {
            type: 'string',
            title: '目标',
            oneOf: [
              { const: 'a', title: 'A' },
              { const: 'b', title: 'B' },
            ],
          },
          custom: { type: 'string', title: '自定义' },
          q1: multiTodo.elicitationData.requestedSchema.properties.q1,
        },
        required: [],
      },
    },
  };

  beforeEach(() => {
    mockRespondElicitation.mockClear();
    mockRespondElicitation.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetElicitationDialog();
  });

  it('T-QM1: items.anyOf 渲染为勾选组而非文本框', () => {
    const { container } = render(
      <ElicitationDialog open onOpenChange={vi.fn()} todo={multiTodo} />,
    );
    const group = screen.getByRole('group', { name: '要做的事' });
    expect(group).toBeDefined();
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    // 标签取 title
    expect(within(group).getByText('自动跑测试')).toBeDefined();
    expect(within(group).getByText('生成文档')).toBeDefined();
    expect(within(group).getByText('部署')).toBeDefined();
    // 不再渲染为文本框
    expect(container.querySelector('#q1')).toBeNull();
  });

  it('T-QM1b: 选项说明可见', () => {
    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={multiTodo} />);
    expect(screen.getByText('提交前运行单测与 E2E')).toBeDefined();
  });

  it('T-QM2: 依次勾选后以逗号拼接回传（顺序=勾选顺序）', async () => {
    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={multiTodo} />);
    const group = screen.getByRole('group', { name: '要做的事' });
    const boxes = within(group).getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByText('提交'));
    await waitFor(() => {
      expect(mockRespondElicitation).toHaveBeenCalledWith({
        variables: {
          requestId: 'el-req-multi',
          action: 'accept',
          values: expect.objectContaining({ q1: '自动跑测试,生成文档' }),
        },
      });
    });
  });

  it('T-QM2b: 取消勾选后拼接剩余项；全部取消保持空数组', async () => {
    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={multiTodo} />);
    const q1 = screen.getByRole('group', { name: '要做的事' });
    const q1Boxes = within(q1).getAllByRole('checkbox');
    fireEvent.click(q1Boxes[0]);
    fireEvent.click(q1Boxes[1]);
    fireEvent.click(q1Boxes[0]);

    const extras = screen.getByRole('group', { name: '附加项' });
    const extraBoxes = within(extras).getAllByRole('checkbox');
    fireEvent.click(extraBoxes[0]);
    fireEvent.click(extraBoxes[0]);

    fireEvent.click(screen.getByText('提交'));
    await waitFor(() => {
      expect(mockRespondElicitation).toHaveBeenCalledWith({
        variables: {
          requestId: 'el-req-multi',
          action: 'accept',
          values: expect.objectContaining({ q1: '生成文档', extras: [] }),
        },
      });
    });
  });

  it('T-QM3: 必答多选空选时禁用提交并提示', () => {
    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={multiTodo} />);
    expect(screen.getByRole('group', { name: '要做的事' })).toBeDefined();
    const submitBtn = screen.getByText('提交') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(screen.getByText(/请填写必填项：要做的事/)).toBeDefined();
  });

  it('T-QM4: items.enum / items.oneOf 数组字段仍以数组提交', async () => {
    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={mixedTodo} />);
    const envs = screen.getByRole('group', { name: '环境' });
    fireEvent.click(within(envs).getByText('dev'));
    const stages = screen.getByRole('group', { name: '阶段' });
    fireEvent.click(within(stages).getByText('阶段一'));
    fireEvent.click(screen.getByText('提交'));
    await waitFor(() => {
      expect(mockRespondElicitation).toHaveBeenCalledWith({
        variables: {
          requestId: 'el-req-mixed',
          action: 'accept',
          values: expect.objectContaining({ envs: ['dev'], stages: ['s1'] }),
        },
      });
    });
  });

  it('T-QM5: 单选与自由文本提交行为不变', async () => {
    render(<ElicitationDialog open onOpenChange={vi.fn()} todo={mixedTodo} />);
    fireEvent.click(screen.getByLabelText('A'));
    fireEvent.change(screen.getByLabelText('自定义'), { target: { value: '自由输入' } });
    fireEvent.click(screen.getByText('提交'));
    await waitFor(() => {
      expect(mockRespondElicitation).toHaveBeenCalledWith({
        variables: {
          requestId: 'el-req-mixed',
          action: 'accept',
          values: expect.objectContaining({ target: 'a', custom: '自由输入' }),
        },
      });
    });
  });

  it('T-QM6: joinMultiSelectValues 边界（空数组/含逗号/非字符串/非 anyOf/非数组）', () => {
    const properties = {
      q1: {
        type: 'array',
        items: { anyOf: [{ const: 'A', title: 'A' }, { const: 'B', title: 'B' }] },
      },
      envs: { type: 'array', items: { enum: ['dev', 'prod'] } },
      stages: { type: 'array', items: { oneOf: [{ const: 's1' }] } },
      plain: { type: 'string' },
    };

    expect(joinMultiSelectValues({ q1: [] }, properties)).toEqual({ q1: [] });
    expect(joinMultiSelectValues({ q1: ['A', 'B'] }, properties)).toEqual({ q1: 'A,B' });
    expect(joinMultiSelectValues({ q1: ['A,B'] }, properties)).toEqual({ q1: 'A,B' });
    expect(joinMultiSelectValues({ q1: [{ id: 1 }] }, properties)).toEqual({ q1: '{"id":1}' });
    expect(joinMultiSelectValues({ envs: ['dev'], stages: ['s1'] }, properties)).toEqual({
      envs: ['dev'],
      stages: ['s1'],
    });
    // 历史草稿/异常报文：非数组原样透传
    expect(joinMultiSelectValues({ q1: '手动输入' }, properties)).toEqual({ q1: '手动输入' });
    // 未涉及的键不丢失
    expect(joinMultiSelectValues({ plain: '文本', q1: ['A'] }, properties)).toEqual({
      plain: '文本',
      q1: 'A',
    });
  });
});
