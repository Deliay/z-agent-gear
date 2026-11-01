import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import NodeDetailDrawer, { type NodeDetailTarget } from '../NodeDetailDrawer'
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow'

vi.mock('@/components/session/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}))

vi.mock('@/hooks/useHumanNodeActions', () => ({
  useHumanNodeActions: () => ({
    input: '',
    setInput: vi.fn(),
    rejectOpen: false,
    setRejectOpen: vi.fn(),
    reason: '',
    setReason: vi.fn(),
    submitting: false,
    handleComplete: vi.fn(),
    handleReject: vi.fn(),
    canReject: false,
  }),
}))

function node(overrides: Partial<WorkflowNodeData> = {}): WorkflowNodeData {
  return {
    id: 'n1',
    nodeKey: 'review',
    type: 'HUMAN',
    name: '审核实现',
    description: '人工审核实现方案',
    status: 'REJECT',
    stage: '方案阶段',
    sessionId: null,
    prompts: null,
    artifactTitles: null,
    agentConfig: null,
    requiresWorktree: null,
    linkUpstreamPullRequest: false,
    sortOrder: null,
    dependsOn: [],
    createdAt: '',
    startedAt: '2026-10-30T10:00:00Z',
    reworkedAt: '2026-10-31T10:00:00Z',
    reworkCount: 2,
    rejectInfo: { reason: '缺少测试覆盖', fromNodeId: 'n0', at: '' },
    failInfo: null,
    ...overrides,
  }
}

function instance(overrides: Partial<WorkflowInstanceData> = {}): WorkflowInstanceData {
  return {
    id: 'inst-1',
    configuredWorkflowId: null,
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: '实例',
    currentNodeNames: [],
    lastNodeName: null,
    lastNodeStatus: null,
    archived: false,
    workspace: null,
    controller: null,
    workflowWorktreePath: null,
    workflowWorktreeBranch: null,
    nodes: [node()],
    blackboard: [
      {
        key: 'n1-审核实现-产物-评审报告',
        value: '# 评审结论',
        updatedAt: '',
      },
    ],
    blackboardTrash: [],
    additionalPrompts: [],
    pullRequestLinks: [
      {
        pullRequestId: 'acme/repo#1',
        prUrl: 'https://github.com/acme/repo/pull/1',
        nodeId: 'n1',
        nodeName: '审核实现',
        registeredAt: '',
        checkRunUrl: 'https://checks/1',
        lastSyncedCommitSha: 'abcdef1',
        lastSyncAt: '2026-10-31T12:00:00Z',
        lastSyncError: null,
      },
    ],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function renderDrawer(target: NodeDetailTarget | null, inst = instance()) {
  return render(
    <NodeDetailDrawer
      open={target != null}
      onOpenChange={() => {}}
      instance={inst}
      target={target}
      onOpenSession={vi.fn()}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('NodeDetailDrawer', () => {
  it('T-UI4-SH5 节点详情字段齐全：名称/阶段/状态/说明/返工/打回原因/产物/关联 PR', () => {
    renderDrawer({ type: 'node', nodeId: 'n1' })

    expect(screen.getByText('审核实现')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-node-status')).toHaveTextContent('已打回')
    expect(screen.getByText('方案阶段')).toBeInTheDocument()
    expect(screen.getByText('人工审核实现方案')).toBeInTheDocument()
    expect(screen.getByText(/返工 2 次/)).toBeInTheDocument()
    expect(screen.getByText(/打回理由：缺少测试覆盖/)).toBeInTheDocument()
    expect(screen.getByText('评审报告')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('# 评审结论')
    expect(screen.getByText('acme/repo#1')).toBeInTheDocument()
    expect(screen.getByText(/最近同步：2026-10-31T12:00:00Z/)).toBeInTheDocument()
  })

  it('T-UI4-SH6 失败节点展示失败原因', () => {
    renderDrawer(
      { type: 'node', nodeId: 'n1' },
      instance({
        nodes: [
          node({
            status: 'FAILED',
            rejectInfo: null,
            failInfo: { reason: '会话超时', source: 'SESSION_STUCK', at: '' },
          }),
        ],
      }),
    )
    expect(screen.getByText(/失败原因：会话超时/)).toBeInTheDocument()
  })

  it('T-UI4-SH7 资源详情：黑板渲染 Markdown，追加提示词按纯文本渲染', () => {
    const { rerender } = renderDrawer({
      type: 'resource',
      resource: {
        id: 'blackboard:1',
        kind: 'blackboard',
        title: '评审报告',
        value: '# 结论',
        url: null,
        checkRunUrl: null,
        pullRequestId: null,
        nodeId: 'n1',
      },
    })
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('# 结论')

    rerender(
      <NodeDetailDrawer
        open
        onOpenChange={() => {}}
        instance={instance()}
        target={{
          type: 'resource',
          resource: {
            id: 'prompt:1',
            kind: 'prompt',
            title: 'review',
            value: '请重点检查 inline comment',
            url: null,
            checkRunUrl: null,
            pullRequestId: null,
            nodeId: 'n1',
          },
        }}
      />,
    )
    const prompt = screen.getByText('请重点检查 inline comment')
    expect(prompt.className).toContain('whitespace-pre-wrap')
    expect(prompt.className).toContain('break-all')
  })

  it('T-UI4-SH8 关闭时不渲染内容（关闭后回到原视图）', () => {
    renderDrawer(null)
    expect(screen.queryByText('审核实现')).not.toBeInTheDocument()
    expect(screen.queryByTestId('markdown-content')).not.toBeInTheDocument()
  })

  it('人类节点可操作时展示完成/打回操作区', () => {
    renderDrawer(
      { type: 'node', nodeId: 'n1' },
      instance({ nodes: [node({ status: 'RUNNING', rejectInfo: null })] }),
    )
    expect(screen.getByLabelText('审核实现 完成输入')).toBeInTheDocument()
    expect(screen.getByText('打回')).toBeInTheDocument()
  })

  it('节点不存在时展示兜底文案', () => {
    renderDrawer({ type: 'node', nodeId: 'missing' })
    expect(screen.getByText('节点不存在或已被删除')).toBeInTheDocument()
  })
})
