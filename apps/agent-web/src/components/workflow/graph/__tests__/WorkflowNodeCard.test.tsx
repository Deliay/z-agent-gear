import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import WorkflowNodeCard, { type WorkflowNodeCardNode } from '../WorkflowNodeCard'
import type { WorkflowGraphNodeData } from '../graph-layout'

const mockActivity = vi.hoisted(() => ({
  value: { activity: null as null | { kind: 'thinking' | 'tool_call' | 'text'; text: string }, tokenUsage: null as number | null },
}))
const mockHandleComplete = vi.fn()
const mockSetRejectOpen = vi.fn()

vi.mock('@/hooks/useNodeSessionActivity', () => ({
  useNodeSessionActivity: () => mockActivity.value,
}))

vi.mock('@/hooks/useHumanNodeActions', () => ({
  useHumanNodeActions: () => ({
    input: '',
    setInput: vi.fn(),
    rejectOpen: false,
    setRejectOpen: mockSetRejectOpen,
    reason: '',
    setReason: vi.fn(),
    submitting: false,
    handleComplete: mockHandleComplete,
    handleReject: vi.fn(),
    canReject: false,
  }),
}))

function data(overrides: Partial<WorkflowGraphNodeData> = {}): WorkflowGraphNodeData {
  return {
    instanceId: 'inst-1',
    nodeId: 'n1',
    name: '实现',
    type: 'AI',
    status: 'RUNNING',
    stage: '实现阶段',
    description: null,
    harness: 'OpenCode',
    model: 'gpt-4o',
    sessionId: 's1',
    reworkCount: 0,
    prLinks: [],
    hasCheckRun: false,
    resources: [],
    moreResources: 0,
    actionable: false,
    onOpenDetail: vi.fn(),
    onOpenResource: vi.fn(),
    ...overrides,
  }
}

// 卡片含 React Flow Handle（连线锚点），需要 provider 上下文
function card(props: unknown) {
  return (
    <ReactFlowProvider>
      <WorkflowNodeCard {...(props as NodeProps<WorkflowNodeCardNode>)} />
    </ReactFlowProvider>
  )
}

function renderCard(overrides: Partial<WorkflowGraphNodeData> = {}) {
  const props = {
    id: 'n1',
    data: data(overrides),
  } as unknown as NodeProps<WorkflowNodeCardNode>
  return render(card(props))
}

beforeEach(() => {
  mockActivity.value = { activity: null, tokenUsage: null }
  mockHandleComplete.mockClear()
  mockSetRejectOpen.mockClear()
})

describe('WorkflowNodeCard', () => {
  it('T-UI4-NC1 七态渲染状态徽标与状态色脊', () => {
    const { rerender } = renderCard({ status: 'RUNNING' })
    expect(screen.getByTestId('node-status-badge-n1')).toHaveTextContent('执行中')
    expect(screen.getByTestId('node-status-spine').className).toContain('bg-info')

    const props = { id: 'n1', data: data({ status: 'FAILED' }) } as unknown as NodeProps<WorkflowNodeCardNode>
    rerender(card(props))
    expect(screen.getByTestId('node-status-badge-n1')).toHaveTextContent('失败')
    expect(screen.getByTestId('node-status-spine').className).toContain('bg-destructive')
  })

  it('T-UI4-NC2 AI 节点展示 Harness 与模型', () => {
    renderCard()
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('gpt-4o')).toBeInTheDocument()
  })

  it('T-WFI-NC1 运行中动态行按活动类型展示提示，不泄露注入正文', () => {
    mockActivity.value = { activity: { kind: 'thinking', text: '…思考结尾' }, tokenUsage: null }
    const { rerender } = renderCard({ status: 'RUNNING' })
    const row = screen.getByTestId('node-live-activity-n1')
    expect(row).toHaveTextContent('思考中...')
    expect(row).not.toHaveTextContent('思考结尾')

    mockActivity.value = { activity: { kind: 'tool_call', text: '执行测试' }, tokenUsage: null }
    rerender(card({ id: 'n1', data: data({ status: 'RUNNING' }) } as unknown as NodeProps<WorkflowNodeCardNode>))
    const toolRow = screen.getByTestId('node-live-activity-n1')
    expect(toolRow).toHaveTextContent('执行中: 执行测试')

    mockActivity.value = { activity: { kind: 'text', text: '…总结' }, tokenUsage: null }
    rerender(card({ id: 'n1', data: data({ status: 'REWORK' }) } as unknown as NodeProps<WorkflowNodeCardNode>))
    const textRow = screen.getByTestId('node-live-activity-n1')
    expect(textRow).toHaveTextContent('Concluding...')
    expect(textRow).not.toHaveTextContent('总结')
  })

  it('T-WFI-NC1b 尚无活动时动态行默认显示「思考中...」', () => {
    mockActivity.value = { activity: null, tokenUsage: null }
    renderCard({ status: 'RUNNING' })
    expect(screen.getByTestId('node-live-activity-n1')).toHaveTextContent('思考中...')
  })

  it('T-WFI-NC2 完成态 token 行：「已完成 · N tokens」且不含「消耗」并带说明 title', () => {
    mockActivity.value = { activity: null, tokenUsage: 3210 }
    const { rerender } = renderCard({ status: 'DONE' })
    const result = screen.getByTestId('node-result-n1')
    expect(result).toHaveTextContent('已完成 · 3210 tokens')
    expect(result).not.toHaveTextContent('消耗')
    expect(result).toHaveAttribute('title', '该数值为会话当前上下文长度')
    expect(screen.queryByTestId('node-live-activity-n1')).not.toBeInTheDocument()

    mockActivity.value = { activity: null, tokenUsage: null }
    rerender(card({ id: 'n1', data: data({ status: 'DONE' }) } as unknown as NodeProps<WorkflowNodeCardNode>))
    expect(screen.getByTestId('node-result-n1')).toHaveTextContent(/^已完成$/)
  })

  it('T-WFI-NC3 渲染 target(上)/source(下) Handle 且不拦截点击', () => {
    const { container } = renderCard()
    const target = container.querySelector('.react-flow__handle-top')
    const source = container.querySelector('.react-flow__handle-bottom')
    expect(target).toBeTruthy()
    expect(source).toBeTruthy()
    expect(target!.className).toContain('pointer-events-none')
    expect(source!.className).toContain('pointer-events-none')
  })

  it('T-UI4-NC5 PR / 检查项 / 返工徽标按有无信息显隐', () => {
    renderCard({ reworkCount: 2 })
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.queryByText('PR')).not.toBeInTheDocument()

    const link = {
      pullRequestId: 'acme/repo#1',
      prUrl: 'https://github.com/acme/repo/pull/1',
      nodeId: 'n1',
      nodeName: '实现',
      registeredAt: '',
      checkRunUrl: 'https://checks/1',
      lastSyncedCommitSha: 'abcdef123',
      lastSyncAt: '',
      lastSyncError: null,
    }
    const { container } = render(
      card({ id: 'n1', data: data({ status: 'DONE', prLinks: [link], hasCheckRun: true }) } as unknown as NodeProps<WorkflowNodeCardNode>),
    )
    expect(container.querySelector('a[href="https://github.com/acme/repo/pull/1"]')).toBeTruthy()
    expect(screen.getByText('检查项')).toBeInTheDocument()
  })

  it('T-UI4-NC6 人类节点可操作时展示输入与完成/打回，操作不冒泡', () => {
    renderCard({ type: 'HUMAN', actionable: true, harness: null, model: null })
    const textarea = screen.getByLabelText('实现 完成输入')
    expect(textarea.className).toContain('nodrag')
    expect(screen.getByText('完成').closest('div')?.className).toContain('nodrag')
    fireEvent.click(screen.getByText('完成'))
    expect(mockHandleComplete).toHaveBeenCalled()
    fireEvent.click(screen.getByText('打回'))
    expect(mockSetRejectOpen).toHaveBeenCalledWith(true)
  })

  it('T-UI4-NC7 头部点击打开节点详情抽屉', () => {
    const onOpenDetail = vi.fn()
    renderCard({ onOpenDetail })
    fireEvent.click(screen.getByRole('button', { name: '实现 详情' }))
    expect(onOpenDetail).toHaveBeenCalledWith('n1')
  })

  it('T-UI4-NC8 资源小卡片横排渲染并点击回调', () => {
    const onOpenResource = vi.fn()
    renderCard({
      status: 'DONE',
      resources: [
        { id: 'r1', kind: 'blackboard', title: '评审报告', value: 'v', url: null, checkRunUrl: null, pullRequestId: null, nodeId: 'n1' },
      ],
      onOpenResource,
    })
    expect(screen.getByTestId('resource-row').className).not.toContain('flex-wrap')
    fireEvent.click(screen.getByText('评审报告'))
    expect(onOpenResource).toHaveBeenCalledTimes(1)
  })
})
