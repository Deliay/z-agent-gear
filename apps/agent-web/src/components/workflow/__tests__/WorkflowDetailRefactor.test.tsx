import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WorkflowTopBar from '../WorkflowTopBar';
import WorkflowAlertBanners from '../WorkflowAlertBanners';
import WorkflowInspectorDrawer from '../WorkflowInspectorDrawer';
import NodeDetailDrawer from '../NodeDetailDrawer';
import SessionSidePanel from '../SessionSidePanel';
import WorkflowNodeCard from '../graph/WorkflowNodeCard';
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, className }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [vi.fn(), { loading: false }],
  useQuery: () => ({ data: undefined, loading: false }),
}));

vi.mock('@/components/MobileBackButton', () => ({
  default: () => null,
}));

vi.mock('@/components/session/SessionView', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid="mock-session-view">{sessionId}</div>,
}));

vi.mock('@/hooks/useNodeSessionActivity', () => ({
  useNodeSessionActivity: () => ({ activity: { kind: 'text' }, tokenUsage: null }),
}));

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}));

function makeNode(overrides: Partial<WorkflowNodeData> = {}): WorkflowNodeData {
  return {
    id: 'n1',
    nodeKey: 'review',
    type: 'HUMAN',
    name: '人类终审',
    description: '请核对 PRD 与方案',
    status: 'RUNNING',
    stage: '评审',
    sessionId: null,
    prompts: null,
    artifactTitles: ['设计方案'],
    agentConfig: null,
    requiresWorktree: null,
    linkUpstreamPullRequest: false,
    sortOrder: 1,
    dependsOn: [],
    createdAt: '2026-11-27T00:00:00Z',
    startedAt: '2026-11-27T01:00:00Z',
    reworkedAt: null,
    reworkCount: 0,
    retryCount: 0,
    nextRetryAt: null,
    rejectInfo: null,
    failInfo: null,
    ...overrides,
  };
}

function makeInstance(): WorkflowInstanceData {
  return {
    id: 'inst-1',
    configuredWorkflowId: 'cfg-1',
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: 'UI 重构全流程',
    currentNodeNames: ['人类终审'],
    lastNodeName: null,
    lastNodeStatus: null,
    archived: false,
    workspace: { id: 'ws-1', name: 'z-agent-gear' },
    controller: { id: 'ctrl-1', name: 'cloud-dev-01' },
    workflowWorktreePath: '/repo/.worktrees/ui-refactor',
    workflowWorktreeBranch: 'feat/ui-refactor',
    nodes: [
      makeNode({ id: 'n0', type: 'AI', name: '编写提案', status: 'DONE' }),
      makeNode({ id: 'n1', type: 'HUMAN', name: '人类终审', status: 'RUNNING' }),
    ],
    blackboard: [
      { key: 'n1-人类终审-产物-设计方案', value: '详细产物内容', updatedAt: '2026-11-27T05:00:00Z' },
    ],
    blackboardTrash: [
      { key: 'old-draft', value: '已废弃草稿', updatedAt: '2026-11-27T04:00:00Z' },
    ],
    additionalPrompts: [
      { key: 'review-note', value: '注意暗色模式对比度' },
    ],
    pullRequestLinks: [
      {
        nodeId: 'n1',
        nodeName: '人类终审',
        pullRequestId: 'Deliay/z-agent-gear#598',
        prUrl: 'https://github.com/Deliay/z-agent-gear/pull/598',
        registeredAt: '2026-11-27T05:00:00Z',
        checkRunUrl: null,
        lastSyncAt: null,
        lastSyncedCommitSha: null,
        lastSyncError: null,
      },
    ],
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T05:00:00Z',
  };
}

describe('工作流实例详情重构（T-WF-DETAIL-1~6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-WF-DETAIL-1: WorkflowTopBar 展示完成进度(tabular-nums)、环境信息胶囊 Popover 与图表模式实例资源入口', () => {
    const onOpenInspector = vi.fn();
    render(
      <WorkflowTopBar
        instance={makeInstance()}
        viewMode="graph"
        onViewModeChange={vi.fn()}
        onOpenRename={vi.fn()}
        onOpenInspector={onOpenInspector}
        onArchive={vi.fn()}
        onOpenDelete={vi.fn()}
      />,
    );

    const progress = screen.getByTestId('workflow-progress-badge');
    expect(progress).toHaveTextContent('已完成 1/2');
    expect(progress).toHaveClass('tabular-nums');

    fireEvent.click(screen.getByTestId('workflow-env-capsule'));
    expect(screen.getByText('运行环境信息')).toBeInTheDocument();
    expect(screen.getByText('cloud-dev-01')).toBeInTheDocument();
    expect(screen.getByText('feat/ui-refactor')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('workflow-inspector-toggle'));
    expect(onOpenInspector).toHaveBeenCalledTimes(1);
  });

  it('T-WF-DETAIL-2: WorkflowAlertBanners 不含原始 ⚠️ 表情且支持点击失败节点直达详情与会话', () => {
    const onSelectNode = vi.fn();
    const onOpenSession = vi.fn();
    const failedNode = makeNode({
      id: 'n-fail',
      type: 'AI',
      name: '代码实现',
      status: 'FAILED',
      sessionId: 'sess-fail',
      failInfo: { reason: '测试失败', source: 'LLM_REPORTED', at: '2026-11-27T05:00:00Z' },
    });

    render(
      <WorkflowAlertBanners
        instance={makeInstance()}
        blockedNodes={[failedNode]}
        onOpenContinue={vi.fn()}
        onSelectNode={onSelectNode}
        onOpenSession={onOpenSession}
      />,
    );

    const alert = screen.getByTestId('workflow-blocked-notice');
    expect(alert.textContent).not.toContain('⚠️');
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(onSelectNode).toHaveBeenCalledWith('n-fail');
    fireEvent.click(screen.getByRole('button', { name: '打开会话' }));
    expect(onOpenSession).toHaveBeenCalledWith(failedNode);
  });

  it('T-WF-DETAIL-3: WorkflowInspectorDrawer 在图表模式下展示黑板、垃圾桶、关联 PR 与追加提示词', () => {
    render(
      <WorkflowInspectorDrawer
        open={true}
        onOpenChange={vi.fn()}
        instance={makeInstance()}
      />,
    );

    const drawer = screen.getByTestId('workflow-inspector-drawer');
    expect(drawer).toHaveTextContent('实例资源');
    expect(drawer).toHaveTextContent('工作流黑板');
    expect(drawer).toHaveTextContent('垃圾桶');
    expect(drawer).toHaveTextContent('关联 Pull Request');
    expect(drawer).toHaveTextContent('追加提示词');
  });

  it('T-WF-DETAIL-4: WorkflowNodeCard 中文化汇总动态行并支持选中高亮态', () => {
    render(
      <WorkflowNodeCard
        id="n-ai"
        type="workflowNode"
        selected={false}
        dragging={false}
        zIndex={1}
        selectable
        deletable
        draggable
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={{
          instanceId: 'inst-1',
          nodeId: 'n-ai',
          name: 'AI 实现节点',
          type: 'AI',
          status: 'RUNNING',
          stage: '开发',
          description: null,
          harness: 'OpenCode',
          model: 'claude-sonnet',
          sessionId: 'sess-1',
          reworkCount: 0,
          prLinks: [],
          hasCheckRun: false,
          resources: [],
          moreResources: 0,
          actionable: false,
          selected: true,
          onOpenDetail: vi.fn(),
          onOpenResource: vi.fn(),
        }}
      />,
    );

    const card = screen.getByTestId('workflow-node-card-n-ai');
    expect(card).toHaveAttribute('data-selected', 'true');
    expect(card.className).toContain('border-primary');
    expect(screen.getByTestId('node-live-activity-n-ai')).toHaveTextContent('正在汇总结果…');
    expect(card.textContent).not.toContain('Concluding...');
  });

  it('T-WF-DETAIL-5: NodeDetailDrawer 将人类操作与关联 PR 前置于产物之前', () => {
    render(
      <NodeDetailDrawer
        open={true}
        onOpenChange={vi.fn()}
        instance={makeInstance()}
        target={{ type: 'node', nodeId: 'n1' }}
      />,
    );

    const humanSection = screen.getByTestId('drawer-human-actions-section');
    const prSection = screen.getByTestId('drawer-pr-section');
    const artifactsSection = screen.getByTestId('drawer-artifacts-section');

    // DOM 文档顺序：humanSection < prSection < artifactsSection
    expect(humanSection.compareDocumentPosition(prSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prSection.compareDocumentPosition(artifactsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('T-WF-DETAIL-6: SessionSidePanel 以 Sheet 展示所属节点名、状态徽标与独立页面打开链接', () => {
    render(
      <SessionSidePanel
        sessionId="sess-123"
        nodeName="代码实现"
        nodeStatus="RUNNING"
        onClose={vi.fn()}
      />,
    );

    const panel = screen.getByTestId('session-side-panel');
    expect(panel).toHaveTextContent('代码实现 · 节点会话');
    expect(panel).toHaveTextContent('执行中');
    const openLink = screen.getByRole('link', { name: '独立页面打开' });
    expect(openLink).toHaveAttribute('href', '/sessions/sess-123');
    expect(screen.getByTestId('mock-session-view')).toHaveTextContent('sess-123');
  });
});
