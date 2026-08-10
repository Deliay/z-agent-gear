import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
    failInfo: null,
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

describe('节点状态标签', () => {
  it('INITIALIZING 显示为「等待中」', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([makeNode({ type: 'AI', status: 'INITIALIZING' })])}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('等待中')).toBeDefined();
  });

  it('FAILED 显示为「失败」并展示失败原因与人工介入引导', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([
          makeNode({
            type: 'AI',
            status: 'FAILED',
            failInfo: { reason: '会话在系统提醒后再次停止', source: 'SESSION_STUCK', at: '2026-08-08T00:00:00Z' },
          }),
        ])}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('失败', { exact: true })).toBeDefined();
    expect(screen.getByText(/失败原因：会话在系统提醒后再次停止/)).toBeDefined();
    expect(screen.getByText(/需要人工介入/)).toBeDefined();
  });
});

describe('节点产物聚合展示', () => {
  const entry = (key: string, value: string) => ({
    key,
    value,
    updatedAt: '2026-08-08T00:00:00Z',
  });

  it('节点卡片内展示本节点产物的标题与内容', () => {
    const instance = makeInstance([makeNode({ status: 'DONE' })]);
    instance.blackboard = [entry('n1-评审-产物-输入', '评审通过，可以开发')];

    render(<WorkflowNodeTree instance={instance} onOpenSession={vi.fn()} />);

    expect(screen.getByText('产物（1）')).toBeDefined();
    expect(screen.getByText('输入')).toBeDefined();
    expect(screen.getByText('评审通过，可以开发')).toBeDefined();
  });

  it('只展示本节点产物，不混入其他节点', () => {
    const instance = makeInstance([
      makeNode({ id: 'n1', name: '评审', status: 'DONE' }),
      makeNode({ id: 'n2', name: '开发', type: 'AI', status: 'DONE' }),
    ]);
    instance.blackboard = [
      entry('n1-评审-产物-输入', '评审意见'),
      entry('n2-开发-产物-代码', '计算器代码 v1'),
    ];

    render(<WorkflowNodeTree instance={instance} onOpenSession={vi.fn()} />);

    const reviewCard = screen.getByText('评审').closest('div.rounded-lg')!;
    const devCard = screen.getByText('开发').closest('div.rounded-lg')!;
    expect(within(reviewCard).getByText('评审意见')).toBeDefined();
    expect(within(reviewCard).queryByText('计算器代码 v1')).toBeNull();
    expect(within(devCard).getByText('计算器代码 v1')).toBeDefined();
  });

  it('无产物时不显示产物区块', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([makeNode({ status: 'DONE' })])}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.queryByText(/^产物（/)).toBeNull();
  });

  it('产物内容以 Markdown 渲染', () => {
    const instance = makeInstance([makeNode({ status: 'DONE' })]);
    instance.blackboard = [entry('n1-评审-产物-报告', '**结论**：通过')];

    render(<WorkflowNodeTree instance={instance} onOpenSession={vi.fn()} />);

    expect(screen.getByText('结论').tagName).toBe('STRONG');
  });
});

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
