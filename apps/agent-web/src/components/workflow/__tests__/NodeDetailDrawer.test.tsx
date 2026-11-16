import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import NodeDetailDrawer, { type NodeDetailTarget } from '../NodeDetailDrawer'
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow'

vi.mock('@/components/session/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}))

const mockFailNode = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockFailNode, { loading: false }],
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
    retryCount: 0,
    nextRetryAt: null,
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
    // 检查项外链 + 短 sha（与列表视图/资源详情口径一致）
    const checkRun = screen.getByRole('link', { name: '检查项' })
    expect(checkRun).toHaveAttribute('href', 'https://checks/1')
    expect(checkRun).toHaveAttribute('title', '检查项 · commit abcdef1')
    expect(screen.getByText(/· commit abcdef1/)).toBeInTheDocument()
    expect(screen.getByText(/最近同步：2026-10-31T12:00:00Z/)).toBeInTheDocument()
  })

  it('T-WFI-SH1 关联 PR 区块位于产物之前（同时存在两者时）', () => {
    renderDrawer({ type: 'node', nodeId: 'n1' })

    const prTitle = screen.getByText('关联 Pull Request')
    const artifactTitle = screen.getByText(/^产物（\d+）$/)
    // Node.DOCUMENT_POSITION_FOLLOWING：产物标题在 PR 标题之后
    expect(prTitle.compareDocumentPosition(artifactTitle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('T-WFI-SH1b 仅产物或仅 PR 时展示正常', () => {
    const artifactsOnly = instance({ pullRequestLinks: [] })
    renderDrawer({ type: 'node', nodeId: 'n1' }, artifactsOnly)
    expect(screen.getByText(/^产物（\d+）$/)).toBeInTheDocument()
    expect(screen.queryByText('关联 Pull Request')).not.toBeInTheDocument()
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

describe('NodeDetailDrawer 中断自动重试（T-FE2/T-FE3）', () => {
  function renderRetry(nodeOverrides: Partial<WorkflowNodeData>, onRestartNode = vi.fn()) {
    const inst = instance({
      nodes: [
        node({
          type: 'AI',
          status: 'RETRY_FAILED',
          failInfo: { reason: '中断自动重试 10 次仍未推进，需要人工介入', source: 'RETRY_EXHAUSTED', at: '' },
          ...nodeOverrides,
        }),
      ],
    })
    render(
      <NodeDetailDrawer
        open
        onOpenChange={() => {}}
        instance={inst}
        target={{ type: 'node', nodeId: 'n1' }}
        onRestartNode={onRestartNode}
      />,
    )
    return { onRestartNode }
  }

  it('T-FE2: RETRY_FAILED 展示独立徽标、重试失败原因、重启按钮与重试进度', () => {
    const { onRestartNode } = renderRetry({
      retryCount: 10,
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(screen.getByTestId('drawer-node-status')).toHaveTextContent('重试失败')
    expect(screen.getByText(/重试失败原因：中断自动重试 10 次仍未推进/)).toBeInTheDocument()
    expect(screen.getByText('自动重试')).toBeInTheDocument()
    expect(screen.getByText(/自动重试 10\/10 · 下次/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重启节点' }))
    expect(onRestartNode).toHaveBeenCalledTimes(1)
    expect(onRestartNode.mock.calls[0][0]).toMatchObject({ id: 'n1', status: 'RETRY_FAILED' })
  })

  it('T-FE3: retryCount>0 且 nextRetryAt=null 时不展示重试进度', () => {
    renderRetry({ retryCount: 3, nextRetryAt: null })
    expect(screen.queryByText('自动重试')).not.toBeInTheDocument()
    expect(screen.queryByText(/正在恢复会话/)).not.toBeInTheDocument()
  })
})

describe('NodeDetailDrawer 立即失败（T-MNF-W1~W3）', () => {
  function renderNode(nodeOverrides: Partial<WorkflowNodeData>, options: { unavailable?: boolean } = {}) {
    const inst = instance({ nodes: [node({ ...nodeOverrides })] })
    render(
      <NodeDetailDrawer
        open
        onOpenChange={() => {}}
        instance={inst}
        target={{ type: 'node', nodeId: 'n1' }}
        unavailable={options.unavailable}
        onRestartNode={vi.fn()}
      />,
    )
  }

  it('T-MNF-W1 按钮可见性矩阵：仅 AI×RUNNING/REWORK 可见', () => {
    for (const status of ['READY', 'DONE', 'REJECT', 'FAILED', 'RETRY_FAILED'] as const) {
      const { unmount } = render(
        <NodeDetailDrawer
          open
          onOpenChange={() => {}}
          instance={instance({
            nodes: [
              node({
                type: 'AI',
                status,
                rejectInfo: null,
                failInfo:
                  status === 'FAILED' || status === 'RETRY_FAILED'
                    ? { reason: 'r', source: 'MANUAL', at: '' }
                    : null,
              }),
            ],
          })}
          target={{ type: 'node', nodeId: 'n1' }}
        />,
      )
      expect(screen.queryByRole('button', { name: '立即失败' }), `AI×${status}`).not.toBeInTheDocument()
      unmount()
    }

    for (const type of ['HUMAN', 'FLAG'] as const) {
      const { unmount } = render(
        <NodeDetailDrawer
          open
          onOpenChange={() => {}}
          instance={instance({ nodes: [node({ type, status: 'RUNNING', rejectInfo: null })] })}
          target={{ type: 'node', nodeId: 'n1' }}
        />,
      )
      expect(screen.queryByRole('button', { name: '立即失败' }), `${type}`).not.toBeInTheDocument()
      unmount()
    }

    for (const status of ['RUNNING', 'REWORK'] as const) {
      const { unmount } = render(
        <NodeDetailDrawer
          open
          onOpenChange={() => {}}
          instance={instance({ nodes: [node({ type: 'AI', status, rejectInfo: null })] })}
          target={{ type: 'node', nodeId: 'n1' }}
        />,
      )
      expect(screen.getByRole('button', { name: '立即失败' }), `AI×${status}`).toBeInTheDocument()
      unmount()
    }
  })

  it('T-MNF-W1b unavailable=true 时禁用并提示「实例不可用，请先接续」', () => {
    renderNode({ type: 'AI', status: 'RUNNING', rejectInfo: null }, { unavailable: true })
    const btn = screen.getByRole('button', { name: '立即失败' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', '实例不可用，请先接续')
  })

  it('T-MNF-W2 二次确认：取消零副作用，确认才以 {instanceId,nodeId} 调 mutation 并 toast', async () => {
    renderNode({ type: 'AI', status: 'RUNNING', rejectInfo: null })

    fireEvent.click(screen.getByRole('button', { name: '立即失败' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('中断会话')
    expect(dialog).toHaveTextContent('取消全部自动重试')
    expect(dialog).toHaveTextContent('阻断工作流')

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(mockFailNode).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '立即失败' }))
    const confirmDialog = await screen.findByRole('dialog')
    mockFailNode.mockResolvedValueOnce({ data: { failNode: { id: 'n1', status: 'FAILED' } } })
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '确认失败' }))

    await waitFor(() =>
      expect(mockFailNode).toHaveBeenCalledWith({ variables: { instanceId: 'inst-1', nodeId: 'n1' } }),
    )
    const { toast } = await import('sonner')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('节点已标记失败'))
  })

  it('T-MNF-W2b mutation 报错 toast 原样展示，不本地伪造状态', async () => {
    mockFailNode.mockRejectedValueOnce(new Error('节点「执行」当前状态为 DONE，不允许执行「标记失败」（fail）'))
    renderNode({ type: 'AI', status: 'RUNNING', rejectInfo: null })

    fireEvent.click(screen.getByRole('button', { name: '立即失败' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认失败' }))

    const { toast } = await import('sonner')
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '节点「执行」当前状态为 DONE，不允许执行「标记失败」（fail）',
      ),
    )
    // 状态徽标仍为执行中（未本地伪造 FAILED）
    expect(screen.getByTestId('drawer-node-status')).toHaveTextContent('执行中')
  })

  it('T-MNF-W3 FAILED 节点展示「失败来源：人工标记」，RETRY_FAILED 原因+来源两行不回归', () => {
    const { unmount } = render(
      <NodeDetailDrawer
        open
        onOpenChange={() => {}}
        instance={instance({
          nodes: [
            node({
              type: 'AI',
              status: 'FAILED',
              rejectInfo: null,
              failInfo: { reason: '人工标记失败', source: 'MANUAL', at: '' },
            }),
          ],
        })}
        target={{ type: 'node', nodeId: 'n1' }}
      />,
    )
    expect(screen.getByText('失败原因：人工标记失败')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-fail-source')).toHaveTextContent('失败来源：人工标记')
    unmount()

    render(
      <NodeDetailDrawer
        open
        onOpenChange={() => {}}
        instance={instance({
          nodes: [
            node({
              type: 'AI',
              status: 'RETRY_FAILED',
              rejectInfo: null,
              failInfo: { reason: '重试用尽', source: 'RETRY_EXHAUSTED', at: '' },
            }),
          ],
        })}
        target={{ type: 'node', nodeId: 'n1' }}
      />,
    )
    expect(screen.getByText('重试失败原因：重试用尽')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-fail-source')).toHaveTextContent('失败来源：中断重试用尽')
  })
})
