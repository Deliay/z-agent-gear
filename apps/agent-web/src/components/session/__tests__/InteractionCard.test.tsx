import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import InteractionCard from '../InteractionCard';
import type { SessionInteractionData } from '../../../graphql/types';

/**
 * 会话交互卡片（T-IC1~T-IC10）：
 * 各状态渲染 / 倒计时归零禁用 / 提交内容回显 / 多选拼接 / url 白名单 / 审批按钮。
 */

const mockRespondElicitation = vi.fn().mockResolvedValue({});
const mockRespondPermission = vi.fn().mockResolvedValue({});

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn((mutation: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const name = mutation?.definitions?.[0]?.name?.value ?? '';
    if (name === 'RespondPermission') return [mockRespondPermission];
    return [mockRespondElicitation];
  }),
}));

function formInteraction(overrides: Partial<SessionInteractionData> = {}): SessionInteractionData {
  return {
    id: 'i-1',
    sessionId: 'sess-1',
    interactionId: 'el-req-1',
    kind: 'ELICITATION',
    status: 'PENDING',
    mode: 'form',
    message: '请选择目标环境',
    requestedSchema: {
      type: 'object',
      properties: {
        environment: {
          type: 'string',
          title: '目标环境',
          enum: ['staging', 'production'],
        },
        tags: {
          type: 'array',
          title: '标签',
          items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] },
        },
      },
      required: ['environment'],
    },
    url: null,
    elicitationId: 'el-1',
    toolCallId: null,
    toolCall: null,
    options: null,
    response: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: '2026-11-13T00:00:00.000Z',
    respondedAt: null,
    resolvedAt: null,
    history: [],
    ...overrides,
  };
}

function permissionInteraction(overrides: Partial<SessionInteractionData> = {}): SessionInteractionData {
  return {
    ...formInteraction(),
    id: 'i-2',
    interactionId: 'perm-1',
    kind: 'PERMISSION',
    mode: null,
    requestedSchema: null,
    elicitationId: null,
    message: 'Bash: npm test',
    toolCallId: 'tc-1',
    toolCall: { toolCallId: 'tc-1', title: 'Bash: npm test', kind: 'execute', rawInput: { command: 'npm test' } },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockRespondElicitation.mockClear();
  mockRespondPermission.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InteractionCard', () => {
  it('T-IC1: PENDING form 卡片渲染字段、倒计时与容器锚点', () => {
    render(<InteractionCard interaction={formInteraction()} />);
    const card = screen.getByTestId('interaction-card-el-req-1');
    expect(card.getAttribute('data-interaction-id')).toBe('el-req-1');
    expect(screen.getByText('请选择目标环境')).toBeDefined();
    expect(screen.getByLabelText('目标环境')).toBeDefined();
    expect(screen.getByTestId('interaction-countdown').textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(screen.getByTestId('interaction-status').textContent).toBe('待处理');
  });

  it('T-IC2: 倒计时归零本地立即禁用并展示已过期', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
    render(
      <InteractionCard
        interaction={formInteraction({ expiresAt: '2026-11-13T00:00:02.000Z' })}
      />,
    );
    expect(screen.getByText('提交')).toBeDefined();

    act(() => { vi.advanceTimersByTime(3_000); });

    expect(screen.getByTestId('interaction-status').textContent).toBe('已过期');
    expect(screen.queryByText('提交')).toBeNull();
    expect(screen.queryByTestId('interaction-countdown')).toBeNull();
  });

  it('T-IC3: 提交必填校验 + 调 respondElicitation + refetch 回调', async () => {
    const onResponded = vi.fn();
    render(<InteractionCard interaction={formInteraction()} onResponded={onResponded} />);

    const submit = screen.getByText('提交') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/请填写必填项：目标环境/)).toBeDefined();

    fireEvent.click(screen.getByLabelText('staging'));
    expect((screen.getByText('提交') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('提交'));

    await waitFor(() => {
      expect(mockRespondElicitation).toHaveBeenCalledWith({
        variables: { requestId: 'el-req-1', action: 'accept', values: { environment: 'staging' } },
      });
      expect(onResponded).toHaveBeenCalled();
    });
  });

  it('T-IC4: 多选 anyOf 提交前以逗号拼接（顺序 = 勾选顺序）', async () => {
    render(<InteractionCard interaction={formInteraction()} />);
    fireEvent.click(screen.getByLabelText('staging'));
    fireEvent.click(screen.getByText('B'));
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('提交'));

    await waitFor(() => {
      expect(mockRespondElicitation).toHaveBeenCalledWith({
        variables: {
          requestId: 'el-req-1',
          action: 'accept',
          values: { environment: 'staging', tags: 'b,a' },
        },
      });
    });
  });

  it('T-IC5: ACCEPTED 禁用并按 schema 字段标签回显提交内容', () => {
    render(
      <InteractionCard
        interaction={formInteraction({
          status: 'ACCEPTED',
          response: { action: 'accept', values: { environment: 'production', tags: ['a', 'b'] } },
        })}
      />,
    );

    expect(screen.getByTestId('interaction-status').textContent).toBe('已提交');
    expect(screen.queryByText('提交')).toBeNull();
    expect(screen.getByTestId('interaction-submitted').textContent).toContain('目标环境');
    expect(screen.getByTestId('interaction-submitted').textContent).toContain('production');
    expect(screen.getByTestId('interaction-submitted').textContent).toContain('a、b');
  });

  it('T-IC6: DECLINED/CANCELLED/EXPIRED/FAILED 终态禁用 + 徽标文案', () => {
    for (const [status, label] of [
      ['DECLINED', '已拒绝'],
      ['CANCELLED', '已取消'],
      ['EXPIRED', '已过期'],
      ['FAILED', '已失效'],
    ] as const) {
      const { unmount } = render(<InteractionCard interaction={formInteraction({ status })} />);
      expect(screen.getByTestId('interaction-status').textContent).toBe(label);
      expect(screen.queryByText('提交')).toBeNull();
      unmount();
    }
  });

  it('T-IC7: url 模式展示链接，非 http(s) 不打开、也不回传', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { unmount } = render(
      <InteractionCard
        interaction={formInteraction({
          mode: 'url',
          url: 'javascript:alert(1)',
          requestedSchema: null,
        })}
      />,
    );
    fireEvent.click(screen.getByText('打开链接'));
    expect(openSpy).not.toHaveBeenCalled();
    expect(mockRespondElicitation).not.toHaveBeenCalled();
    unmount();

    render(
      <InteractionCard
        interaction={formInteraction({ mode: 'url', url: 'https://example.com/auth', requestedSchema: null })}
      />,
    );
    fireEvent.click(screen.getByText('打开链接'));
    expect(openSpy).toHaveBeenCalledWith('https://example.com/auth', '_blank', 'noopener,noreferrer');
    await waitFor(() => {
      expect(mockRespondElicitation).toHaveBeenCalledWith({
        variables: { requestId: 'el-req-1', action: 'accept', values: null },
      });
    });
    openSpy.mockRestore();
  });

  it('T-IC8: permission PENDING 渲染工具调用摘要与审批选项，点击回传', async () => {
    const onResponded = vi.fn();
    render(<InteractionCard interaction={permissionInteraction()} onResponded={onResponded} />);

    expect(screen.getAllByText('Bash: npm test').length).toBeGreaterThan(0);
    expect(screen.getByText('npm test')).toBeDefined();

    fireEvent.click(screen.getByText('Allow once'));
    await waitFor(() => {
      expect(mockRespondPermission).toHaveBeenCalledWith({
        variables: { requestId: 'perm-1', outcome: 'selected', optionId: 'allow_once' },
      });
      expect(onResponded).toHaveBeenCalled();
    });
  });

  it('T-IC9: permission ACCEPTED 展示所选审批项且禁用按钮', () => {
    render(
      <InteractionCard
        interaction={permissionInteraction({
          status: 'ACCEPTED',
          response: { outcome: 'selected', optionId: 'allow_once' },
        })}
      />,
    );

    expect(screen.getByTestId('interaction-status').textContent).toBe('已批准');
    expect(screen.getByTestId('interaction-selected-option').textContent).toContain('Allow once');
    expect(screen.queryByText('Allow once')).toBeNull();
  });

  it('T-IC10: permission 取消回传 outcome=cancelled', async () => {
    render(<InteractionCard interaction={permissionInteraction()} />);
    fireEvent.click(screen.getByText('取消'));
    await waitFor(() => {
      expect(mockRespondPermission).toHaveBeenCalledWith({
        variables: { requestId: 'perm-1', outcome: 'cancelled', optionId: undefined },
      });
    });
  });
});
