import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import EditInstanceNodeDialog from '../EditInstanceNodeDialog'
import type { WorkflowNodeData } from '@/graphql/workflow'

const mockUseQuery = vi.fn()
const mockUpdateNode = vi.fn().mockResolvedValue({})
const mockRestartNode = vi.fn().mockResolvedValue({})

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  // 按 mutation 文档名区分：重启走独立 mock，其余为 updateWorkflowNode
  useMutation: (doc: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const name = doc?.definitions?.[0]?.name?.value
    if (name === 'RestartNode') return [mockRestartNode]
    return [mockUpdateNode]
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

function makeNode(patch: Partial<WorkflowNodeData> = {}): WorkflowNodeData {
  return {
    id: 'n2',
    nodeKey: 'exec',
    type: 'AI',
    name: 'AI执行',
    description: null,
    status: 'INITIALIZING',
    stage: '开发',
    sessionId: null,
    prompts: ['实现功能'],
    artifactTitles: null,
    agentConfig: {
      acpServerType: 'opencode',
      modeId: null,
      modelId: null,
      initNewWorktree: false,
    },
    requiresWorktree: false,
    linkUpstreamPullRequest: false,
    sortOrder: null,
    dependsOn: [],
    createdAt: '2026-11-15T00:00:00Z',
    startedAt: null,
    reworkedAt: null,
    reworkCount: 0,
    retryCount: 0,
    nextRetryAt: null,
    rejectInfo: null,
    failInfo: null,
    ...patch,
  }
}

function renderDialog(node: WorkflowNodeData, restartMode = false) {
  return render(
    <EditInstanceNodeDialog
      open
      onOpenChange={vi.fn()}
      instanceId="inst-1"
      node={node}
      controllerId="ctrl-1"
      availableServerTypes={['opencode']}
      restartMode={restartMode}
    />,
  )
}

describe('EditInstanceNodeDialog 会话行为区（T-SB-WEB4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseQuery.mockReturnValue({
      data: {
        acpServerOptions: {
          modes: [],
          models: [],
          currentModeId: null,
          currentModelId: null,
          probedAt: '2026-11-15T00:00:00Z',
        },
      },
      loading: false,
    })
  })

  it('编辑模式展示会话行为区，并随 UPDATE_WORKFLOW_NODE 提交 4 字段', async () => {
    renderDialog(makeNode())

    expect(screen.getByTestId('session-behavior-fields')).toBeInTheDocument()
    // 实例节点快照缺字段 → 默认「返工时=原始会话 / 打回后=新会话」
    expect(screen.getByLabelText('AI执行 返工时 原始会话')).toBeChecked()
    expect(screen.getByLabelText('AI执行 打回后 新会话')).toBeChecked()

    // 打回后改为原始会话并勾选压缩
    fireEvent.click(screen.getByLabelText('AI执行 打回后 原始会话'))
    fireEvent.click(screen.getByLabelText('AI执行 打回后压缩原始上下文'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mockUpdateNode).toHaveBeenCalled())
    expect(mockUpdateNode.mock.calls[0][0].variables).toMatchObject({
      instanceId: 'inst-1',
      nodeId: 'n2',
      input: {
        reworkSessionBehavior: 'ORIGINAL_SESSION',
        reworkCompactOriginalContext: false,
        resumeSessionBehavior: 'ORIGINAL_SESSION',
        resumeCompactOriginalContext: true,
      },
    })
  })

  it('实例节点快照的会话行为显式值回显（含读取侧归一）', () => {
    renderDialog(
      makeNode({
        reworkSessionBehavior: 'NEW_SESSION',
        reworkCompactOriginalContext: false,
        resumeSessionBehavior: 'ORIGINAL_SESSION',
        resumeCompactOriginalContext: true,
      }),
    )
    expect(screen.getByLabelText('AI执行 返工时 新会话')).toBeChecked()
    expect(screen.queryByLabelText('AI执行 返工时压缩原始上下文')).not.toBeInTheDocument()
    expect(screen.getByLabelText('AI执行 打回后 原始会话')).toBeChecked()
    expect(screen.getByLabelText('AI执行 打回后压缩原始上下文')).toBeChecked()
  })

  it('重启模式不渲染会话行为区，重启报文不带 4 字段', async () => {
    renderDialog(makeNode({ status: 'RETRY_FAILED' }), true)

    expect(screen.queryByTestId('session-behavior-fields')).not.toBeInTheDocument()
    expect(screen.queryByText('会话行为')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '确认重启' }))
    await waitFor(() => expect(mockRestartNode).toHaveBeenCalled())
    const variables = mockRestartNode.mock.calls[0][0].variables
    expect(Object.keys(variables).sort()).toEqual(['agentConfig', 'instanceId', 'nodeId'])
  })

  it('HUMAN 节点编辑模式不渲染会话行为区', () => {
    renderDialog(
      makeNode({
        type: 'HUMAN',
        name: '评审',
        prompts: null,
        agentConfig: null,
        stage: '验收',
      }),
    )

    expect(screen.queryByTestId('session-behavior-fields')).not.toBeInTheDocument()
  })
})
