import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WorkflowNodeTree from '../workflow/WorkflowNodeTree';
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow';

const mockComplete = vi.fn().mockResolvedValue({});
const mockReject = vi.fn().mockResolvedValue({});

vi.mock('@apollo/client/react', () => ({
  useMutation: (doc: unknown) => {
    const name = JSON.stringify(doc);
    return [name.includes('CompleteHumanNode') ? mockComplete : mockReject];
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeNode(overrides: Partial<WorkflowNodeData> = {}): WorkflowNodeData {
  return {
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
    ...overrides,
  };
}

function makeInstance(nodes: WorkflowNodeData[]): WorkflowInstanceData {
  return {
    id: 'inst-1',
    configuredWorkflowId: 'cfg-1',
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: '测试实例',
    currentNodeNames: [],
    nodes,
    blackboard: [],
    blackboardTrash: [],
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  } as WorkflowInstanceData;
}

describe('WorkflowNodeTree 人类节点输入草稿', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('输入内容持久化到 localStorage，组件重挂后自动恢复', () => {
    const instance = makeInstance([makeNode()]);
    const { unmount } = render(<WorkflowNodeTree instance={instance} onOpenSession={vi.fn()} />);

    const textarea = screen.getByLabelText('评审 完成输入');
    fireEvent.change(textarea, { target: { value: '同意技术方案，但补充埋点' } });

    expect(localStorage.getItem('workflow-node-draft:inst-1:n1')).toBe('同意技术方案，但补充埋点');

    // 模拟轮询期间节点状态翻转导致的卸载重挂
    unmount();
    render(<WorkflowNodeTree instance={makeInstance([makeNode()])} onOpenSession={vi.fn()} />);

    expect(screen.getByLabelText('评审 完成输入')).toHaveValue('同意技术方案，但补充埋点');
  });

  it('不同实例/节点的草稿互不干扰', () => {
    localStorage.setItem('workflow-node-draft:inst-1:n1', '实例一的草稿');
    localStorage.setItem('workflow-node-draft:inst-2:n1', '实例二的草稿');

    render(
      <WorkflowNodeTree
        instance={{ ...makeInstance([makeNode()]), id: 'inst-2' }}
        onOpenSession={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('评审 完成输入')).toHaveValue('实例二的草稿');
  });

  it('完成成功后清除草稿', async () => {
    const instance = makeInstance([makeNode()]);
    render(<WorkflowNodeTree instance={instance} onOpenSession={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('评审 完成输入'), { target: { value: '通过' } });
    expect(localStorage.getItem('workflow-node-draft:inst-1:n1')).toBe('通过');

    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await vi.waitFor(() => {
      expect(mockComplete).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(localStorage.getItem('workflow-node-draft:inst-1:n1')).toBeNull();
    });
  });
});
