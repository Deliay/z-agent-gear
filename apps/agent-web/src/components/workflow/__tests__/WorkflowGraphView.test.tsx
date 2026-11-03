import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow'

/** onInit 交出的实例引用（用于断言 fitView 调用与防抖动） */
const flowApi = vi.hoisted(() => ({
  fitView: vi.fn(),
}))

vi.mock('@apollo/client/react', () => ({
  useQuery: () => ({ data: undefined }),
}))

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const MockReactFlow = (props: {
    onInit?: (instance: unknown) => void
    children?: React.ReactNode
  }) => {
    useEffect(() => {
      props.onInit?.({
        fitView: flowApi.fitView,
        getNodes: () => [],
        fitBounds: vi.fn(),
      })
      // 仅在挂载时初始化一次，模拟真实 React Flow 的 onInit 语义
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <div data-testid="react-flow-mock">{props.children}</div>
  }
  return {
    ...actual,
    ReactFlow: MockReactFlow,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  }
})

import WorkflowGraphView from '../WorkflowGraphView'

function node(overrides: Partial<WorkflowNodeData> & { id: string }): WorkflowNodeData {
  return {
    nodeKey: overrides.id,
    type: 'HUMAN',
    name: overrides.id,
    description: null,
    status: 'READY',
    stage: '阶段',
    sessionId: null,
    prompts: null,
    artifactTitles: null,
    agentConfig: null,
    requiresWorktree: null,
    linkUpstreamPullRequest: false,
    sortOrder: null,
    dependsOn: [],
    createdAt: '',
    startedAt: null,
    reworkedAt: null,
    reworkCount: 0,
    rejectInfo: null,
    failInfo: null,
    ...overrides,
  }
}

function instance(nodes: WorkflowNodeData[]): WorkflowInstanceData {
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
    nodes,
    blackboard: [],
    blackboardTrash: [],
    additionalPrompts: [],
    pullRequestLinks: [],
    createdAt: '',
    updatedAt: '',
  }
}

function chain(statuses: WorkflowNodeData['status'][]): WorkflowNodeData[] {
  return statuses.map((status, index) =>
    node({
      id: `n${index + 1}`,
      status,
      dependsOn: index === 0 ? [] : [`n${index}`],
    }),
  )
}

beforeEach(() => {
  flowApi.fitView.mockClear()
})

describe('WorkflowGraphView 自动定位执行中节点', () => {
  it('T-WFI-V1 有执行中节点时按前后各 2 卡片窗口 fitView（首次 duration 0）', async () => {
    render(
      <WorkflowGraphView
        instance={instance(chain(['DONE', 'DONE', 'DONE', 'RUNNING', 'READY', 'READY', 'READY']))}
      />,
    )

    // fitView 在 requestAnimationFrame 内触发
    await waitFor(() => expect(flowApi.fitView).toHaveBeenCalledTimes(1))
    expect(flowApi.fitView).toHaveBeenCalledWith({
      nodes: [{ id: 'n2' }, { id: 'n3' }, { id: 'n4' }, { id: 'n5' }, { id: 'n6' }],
      padding: 0.2,
      duration: 0,
    })
  })

  it('T-WFI-V2 轮询返回新对象但执行中集合不变时不重复 fitView（防抖动）', async () => {
    const view = render(
      <WorkflowGraphView instance={instance(chain(['DONE', 'RUNNING', 'READY', 'READY']))} />,
    )
    await waitFor(() => expect(flowApi.fitView).toHaveBeenCalledTimes(1))

    // 5s 轮询：节点对象全部重建（引用变化），但执行中仍为 n2
    view.rerender(
      <WorkflowGraphView instance={instance(chain(['DONE', 'RUNNING', 'READY', 'READY']))} />,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(flowApi.fitView).toHaveBeenCalledTimes(1)
  })

  it('T-WFI-V3 执行中节点切换时以 duration 300 重新定位', async () => {
    const view = render(
      <WorkflowGraphView instance={instance(chain(['DONE', 'RUNNING', 'READY', 'READY']))} />,
    )
    await waitFor(() => expect(flowApi.fitView).toHaveBeenCalledTimes(1))

    view.rerender(
      <WorkflowGraphView instance={instance(chain(['DONE', 'DONE', 'RUNNING', 'READY']))} />,
    )

    await waitFor(() => expect(flowApi.fitView).toHaveBeenCalledTimes(2))
    expect(flowApi.fitView).toHaveBeenLastCalledWith(
      expect.objectContaining({ duration: 300 }),
    )
    expect(flowApi.fitView).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodes: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'n4' }] }),
    )
  })

  it('T-WFI-V4 无执行中节点时不主动 fitView（保留整图首屏）', async () => {
    render(<WorkflowGraphView instance={instance(chain(['DONE', 'READY', 'READY']))} />)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(flowApi.fitView).not.toHaveBeenCalled()
  })
})
