import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WorkflowInstancePage from '../WorkflowInstancePage';
import { toast } from 'sonner';
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow';

const mockUseQuery = vi.fn();
const mockDelete = vi.fn().mockResolvedValue({});
const mockNavigate = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockDelete],
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'inst-1' }),
  useNavigate: () => mockNavigate,
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
    lastNodeName: null,
    lastNodeStatus: null,
    archived: false,
    workflowWorktreePath: null,
    workflowWorktreeBranch: null,
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
        prompts: null,
        artifactTitles: null,
        agentConfig: null,
        requiresWorktree: null,
        sortOrder: null,
        dependsOn: [],
        createdAt: '2026-08-08T00:00:00Z',
        startedAt: null,
        reworkedAt: null,
        reworkCount: 0,
        rejectInfo: null,
        failInfo: null,
      },
    ],
    blackboard: [],
    blackboardTrash: [],
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  };
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

describe('WorkflowInstancePage 节点失败强提醒', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeFailedInstance(): WorkflowInstanceData {
    const instance = makeInstance();
    instance.currentNodeNames = [];
    instance.nodes = [
      {
        ...(instance.nodes[0] as WorkflowNodeData),
        id: 'n2',
        type: 'AI',
        name: '代码实现',
        status: 'FAILED',
        failInfo: { reason: '环境不可用', source: 'LLM_REPORTED', at: '2026-08-08T00:00:00Z' },
      } as WorkflowNodeData,
    ];
    return instance;
  }

  it('存在 FAILED 节点时显示阻断 banner（节点名+原因+引导）并 toast 强提醒一次', () => {
    mockUseQuery.mockReturnValue({ data: { workflowInstance: makeFailedInstance() }, loading: false });
    const view = render(<WorkflowInstancePage />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('1 个节点失败');
    expect(alert.textContent).toContain('代码实现');
    expect(alert.textContent).toContain('环境不可用');
    expect(alert.textContent).toContain('人工介入');
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain('代码实现');

    // 轮询再次返回同一失败状态：toast 不重复
    mockUseQuery.mockReturnValue({ data: { workflowInstance: makeFailedInstance() }, loading: false });
    view.rerender(<WorkflowInstancePage />);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('无 FAILED 节点时不显示 banner 也不 toast', () => {
    mockUseQuery.mockReturnValue({ data: { workflowInstance: makeInstance() }, loading: false });
    render(<WorkflowInstancePage />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });
});


describe('WorkflowInstancePage 删除实例', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({ data: { workflowInstance: makeInstance() }, loading: false });
  });

  it('点击「删除实例」弹确认框（说明停流程+删会话），确认后调用删除并跳转回会话列表', async () => {
    render(<WorkflowInstancePage />);

    fireEvent.click(screen.getByRole('button', { name: /删除实例/ }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('停止流程运转');
    expect(dialog.textContent).toContain('删除全部节点会话');
    expect(dialog.textContent).toContain('测试实例');

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({ variables: { id: 'inst-1' } })),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/sessions'));
    expect(toast.success).toHaveBeenCalled();
  });

  it('取消删除不调用 mutation 也不跳转', () => {
    render(<WorkflowInstancePage />);

    fireEvent.click(screen.getByRole('button', { name: /删除实例/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});


describe('WorkflowInstancePage 实例状态与归档', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无执行中节点时展示最后执行节点及其状态 badge', () => {
    const instance = makeInstance();
    instance.currentNodeNames = [];
    (instance as WorkflowInstanceData).lastNodeName = '完成开发';
    (instance as WorkflowInstanceData).lastNodeStatus = 'DONE';
    mockUseQuery.mockReturnValue({ data: { workflowInstance: instance }, loading: false });

    render(<WorkflowInstancePage />);

    expect(screen.getByText('完成开发 · 已完成')).toBeDefined();
    expect(screen.queryByText('暂无执行中的节点')).toBeNull();
  });

  it('点击「归档」调用归档 mutation 并跳转回会话列表', async () => {
    const instance = makeInstance();
    (instance as WorkflowInstanceData).archived = false;
    mockUseQuery.mockReturnValue({ data: { workflowInstance: instance }, loading: false });
    render(<WorkflowInstancePage />);

    fireEvent.click(screen.getByRole('button', { name: /归档/ }));

    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'inst-1', archived: true } }),
      ),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/sessions'));
  });

  it('已归档实例显示「取消归档」，点击后调用 mutation 且不跳转', async () => {
    const instance = makeInstance();
    (instance as WorkflowInstanceData).archived = true;
    mockUseQuery.mockReturnValue({ data: { workflowInstance: instance }, loading: false });
    render(<WorkflowInstancePage />);

    fireEvent.click(screen.getByRole('button', { name: '取消归档' }));

    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'inst-1', archived: false } }),
      ),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
