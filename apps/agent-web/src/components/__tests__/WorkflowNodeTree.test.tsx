import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import WorkflowNodeTree from '../workflow/WorkflowNodeTree';
import { toast } from 'sonner';
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow';

const mockComplete = vi.fn().mockResolvedValue({});
const mockReject = vi.fn().mockResolvedValue({});
const mockRestart = vi.fn().mockResolvedValue({});

vi.mock('@apollo/client/react', () => ({
  useQuery: () => ({ data: { acpCapabilities: [] } }),
  useMutation: (doc: unknown) => {
    const name = JSON.stringify(doc);
    if (name.includes('RestartNode')) return [mockRestart];
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
    lastNodeName: null,
    lastNodeStatus: null,
    archived: false,
    workflowWorktreePath: null,
    workflowWorktreeBranch: null,
    nodes,
    blackboard: [],
    blackboardTrash: [],
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  };
}

describe('节点状态标签', () => {
  it('INITIALIZING 显示为「等待中」', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([makeNode({ type: 'AI', status: 'INITIALIZING' })])}
        onOpenSession={vi.fn()}
      />,
    );
    // INITIALIZING 默认折叠，展开后可见状态 badge
    fireEvent.click(screen.getByRole('button', { name: /评审 展开/ }));
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
    // DONE 默认折叠，展开后可见产物
    fireEvent.click(screen.getByRole('button', { name: /评审 展开/ }));

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
    // DONE 默认折叠，展开两个节点
    for (const name of ['评审', '开发']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`${name} 展开`) }));
    }

    const reviewCard = screen.getByText('评审').closest('div.rounded-lg') as HTMLElement;
    const devCard = screen.getByText('开发').closest('div.rounded-lg') as HTMLElement;
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
    fireEvent.click(screen.getByRole('button', { name: /评审 展开/ }));

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


describe('节点折叠（移动端适配）', () => {
  function nodeInStage(overrides: Partial<WorkflowNodeData> = {}) {
    return makeNode({ type: 'AI', name: '代码实现', description: '实现计算器', ...overrides });
  }

  it('已完成/等待中节点默认折叠：展示类型、标题与状态 badge，隐藏描述等内容', () => {
    for (const status of ['DONE', 'INITIALIZING'] as const) {
      const { unmount } = render(
        <WorkflowNodeTree
          instance={makeInstance([nodeInStage({ status })])}
          onOpenSession={vi.fn()}
        />,
      );
      // 类型、标题、状态 badge 可见
      expect(screen.getByText('AI', { exact: true })).toBeDefined();
      expect(screen.getByText('代码实现')).toBeDefined();
      expect(
        screen.getByText(status === 'DONE' ? '已完成' : '等待中', { exact: true }),
      ).toBeDefined();
      // 折叠后描述等内容不展示
      expect(screen.queryByText('实现计算器')).toBeNull();
      unmount();
    }
  });

  it('折叠的节点仍展示返工次数与「会话」按钮', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([
          nodeInStage({ status: 'DONE', reworkCount: 2, sessionId: 'sess-1' }),
        ])}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('返工 2 次')).toBeDefined();
    expect(screen.getByRole('button', { name: '会话' })).toBeDefined();
    // 内容区仍折叠
    expect(screen.queryByText('实现计算器')).toBeNull();
  });

  it('执行中/已打回/返工中/失败/待开始节点默认展开', () => {
    for (const status of ['RUNNING', 'REJECT', 'REWORK', 'FAILED', 'READY'] as const) {
      const { unmount } = render(
        <WorkflowNodeTree
          instance={makeInstance([nodeInStage({ status })])}
          onOpenSession={vi.fn()}
        />,
      );
      expect(screen.getByText('实现计算器')).toBeDefined();
      unmount();
    }
  });

  it('点击折叠的节点展开全部内容，再次点击折叠回去', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([nodeInStage({ status: 'DONE' })])}
        onOpenSession={vi.fn()}
      />,
    );

    const toggle = screen.getByRole('button', { name: /代码实现/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.getByText('实现计算器')).toBeDefined();
    expect(screen.getByText('已完成', { exact: true })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /代码实现/ }));
    expect(screen.queryByText('实现计算器')).toBeNull();
  });

  it('REWORK 人类节点显示完成/打回操作区（被打回后可重新提交）', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([makeNode({ type: 'HUMAN', status: 'REWORK', reworkCount: 1 })])}
        onOpenSession={vi.fn()}
      />,
    );
    // REWORK 默认展开，操作区可见
    expect(screen.getByLabelText('评审 完成输入')).toBeDefined();
    expect(screen.getByRole('button', { name: '完成' })).toBeDefined();
    expect(screen.getByRole('button', { name: '打回' })).toBeDefined();
  });

  it('展开的节点可手动折叠', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([nodeInStage({ status: 'RUNNING' })])}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByText('实现计算器')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /折叠/ }));
    // 折叠后内容区隐藏，状态 badge 仍展示
    expect(screen.queryByText('实现计算器')).toBeNull();
    expect(screen.getByText('执行中', { exact: true })).toBeDefined();
  });

  it('节点卡片头部行允许换行（flex-wrap）以适配窄屏', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([nodeInStage({ status: 'RUNNING' })])}
        onOpenSession={vi.fn()}
      />,
    );
    const badge = screen.getByText('AI', { exact: true });
    expect(badge.parentElement!.className).toContain('flex-wrap');
  });
});

describe('节点重启（编辑面板模式）', () => {
  beforeEach(() => {
    mockRestart.mockClear();
    mockRestart.mockResolvedValue({});
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('点击「重启」打开编辑面板', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([
          makeNode({ id: 'n-ai', nodeKey: 'exec', type: 'AI', name: '执行', status: 'RUNNING' }),
        ])}
        onOpenSession={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重启' }));
    // 编辑面板出现
    expect(screen.getByText('重启节点「执行」')).toBeDefined();
  });

  it('编辑面板显示 Harness 配置', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([
          makeNode({
            id: 'n-ai',
            nodeKey: 'exec',
            type: 'AI',
            name: '执行',
            status: 'RUNNING',
            agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false },
          }),
        ])}
        onOpenSession={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重启' }));
    expect(screen.getByText('重启节点「执行」')).toBeDefined();
  });

  it('取消则关闭编辑面板', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([
          makeNode({ id: 'n-ai', nodeKey: 'exec', type: 'AI', name: '执行', status: 'RUNNING' }),
        ])}
        onOpenSession={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重启' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByText('重启节点「执行」')).toBeNull();
  });

  it('编辑面板文案说明重启语义', () => {
    render(
      <WorkflowNodeTree
        instance={makeInstance([
          makeNode({ id: 'n-ai', nodeKey: 'exec', type: 'AI', name: '执行', status: 'FAILED' }),
        ])}
        onOpenSession={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重启' }));
    expect(screen.getByText(/重启将关闭当前会话并以新配置重新拉起/)).toBeDefined();
  });
});
