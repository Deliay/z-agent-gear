import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WorkflowInstancePage from '../WorkflowInstancePage';
import type { WorkflowInstanceData } from '@/graphql/workflow';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [vi.fn().mockResolvedValue({})],
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'inst-1' }),
}));

vi.mock('@/components/workflow/BlackboardPanel', () => ({
  default: () => <div data-testid="blackboard-panel" />,
}));

vi.mock('@/components/workflow/SessionSidePanel', () => ({
  default: () => null,
}));

vi.mock('@/components/MobileBackButton', () => ({
  default: () => null,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeInstance(): WorkflowInstanceData {
  return {
    id: 'inst-1',
    configuredWorkflowId: 'cfg-1',
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: '测试实例',
    currentNodeNames: ['评审'],
    nodes: [
      {
        id: 'n1',
        nodeKey: 'review',
        type: 'HUMAN',
        name: '评审',
        description: null,
        status: 'RUNNING',
        stage: '验收',
        sessionId: null,
        createdAt: '2026-08-08T00:00:00Z',
        startedAt: null,
        reworkedAt: null,
        reworkCount: 0,
        rejectInfo: null,
      },
    ],
    blackboard: [],
    blackboardTrash: [],
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  } as WorkflowInstanceData;
}

describe('WorkflowInstancePage 轮询刷新不打断输入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('轮询 refetch（loading=true 且已有数据）时保持内容渲染，不卸载成 spinner', () => {
    mockUseQuery.mockReturnValue({ data: { workflowInstance: makeInstance() }, loading: false });
    const view = render(<WorkflowInstancePage />);

    const textarea = screen.getByLabelText('评审 完成输入');
    fireEvent.change(textarea, { target: { value: '正在输入评审意见' } });
    (textarea as HTMLTextAreaElement).focus();
    expect(document.activeElement).toBe(textarea);

    // 模拟轮询 refetch 进行中（Apollo v4 默认 notifyOnNetworkStatusChange=true 时 loading 反复置 true）
    mockUseQuery.mockReturnValue({ data: { workflowInstance: makeInstance() }, loading: true });
    view.rerender(<WorkflowInstancePage />);

    // 内容不卸载、焦点不丢、输入不丢
    expect(screen.getByLabelText('评审 完成输入')).toHaveValue('正在输入评审意见');
    expect(document.activeElement).toBe(screen.getByLabelText('评审 完成输入'));

    // 轮询返回新数据
    mockUseQuery.mockReturnValue({ data: { workflowInstance: makeInstance() }, loading: false });
    view.rerender(<WorkflowInstancePage />);
    expect(screen.getByLabelText('评审 完成输入')).toHaveValue('正在输入评审意见');
    expect(document.activeElement).toBe(screen.getByLabelText('评审 完成输入'));
  });

  it('首次加载（无数据）时显示 spinner', () => {
    mockUseQuery.mockReturnValue({ data: undefined, loading: true });
    const { container } = render(<WorkflowInstancePage />);
    expect(container.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByLabelText('评审 完成输入')).toBeNull();
  });
});
