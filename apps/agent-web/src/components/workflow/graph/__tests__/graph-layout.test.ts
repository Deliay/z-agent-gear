import { describe, expect, it } from 'vitest'
import {
  GRAPH_NODE_WIDTH,
  buildGraphViewModel,
  estimateNodeHeight,
  layoutGraphNodes,
  pickFocusWindow,
} from '../graph-layout'
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow'

function node(overrides: Partial<WorkflowNodeData> & { id: string }): WorkflowNodeData {
  return {
    nodeKey: overrides.id,
    type: 'AI',
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

describe('layoutGraphNodes', () => {
  it('T-UI4-GL1 竖向布局：链式依赖 y 坐标单调递增', () => {
    const positions = layoutGraphNodes([
      { id: 'a', dependsOn: [], height: 140 },
      { id: 'b', dependsOn: ['a'], height: 140 },
      { id: 'c', dependsOn: ['b'], height: 140 },
    ])
    const ys = ['a', 'b', 'c'].map((id) => positions.get(id)!.y)
    expect(ys[0]).toBeLessThan(ys[1])
    expect(ys[1]).toBeLessThan(ys[2])
  })

  it('T-UI4-GL2 并行分支同层横排（同 y、不同 x）', () => {
    const positions = layoutGraphNodes([
      { id: 'root', dependsOn: [], height: 140 },
      { id: 'left', dependsOn: ['root'], height: 140 },
      { id: 'right', dependsOn: ['root'], height: 140 },
    ])
    expect(positions.get('left')!.y).toBe(positions.get('right')!.y)
    expect(positions.get('left')!.x).not.toBe(positions.get('right')!.x)
  })

  it('T-UI4-GL3 单节点布局：坐标有限且不抛错', () => {
    const positions = layoutGraphNodes([{ id: 'only', dependsOn: [], height: 140 }])
    const only = positions.get('only')!
    expect(Number.isFinite(only.x)).toBe(true)
    expect(Number.isFinite(only.y)).toBe(true)
  })

  it('T-UI4-GL4 节点宽度统一写入 dagre 测量（280）', () => {
    expect(GRAPH_NODE_WIDTH).toBe(280)
  })

  it('T-UI4-GL5 节点高度按分档估算并收敛在 120–260', () => {
    const base = estimateNodeHeight({
      type: 'AI',
      status: 'READY',
      sessionId: null,
      actionable: false,
      resources: [],
      moreResources: 0,
    })
    const rich = estimateNodeHeight({
      type: 'HUMAN',
      status: 'RUNNING',
      sessionId: 's1',
      actionable: true,
      resources: [{ id: 'r1', kind: 'blackboard', title: 't', value: 'v', url: null, checkRunUrl: null, pullRequestId: null, nodeId: 'n1' }],
      moreResources: 0,
    })
    expect(base).toBeGreaterThanOrEqual(120)
    expect(rich).toBeGreaterThan(base)
    expect(rich).toBeLessThanOrEqual(220)
  })
})

describe('buildGraphViewModel', () => {
  it('连线加粗（strokeWidth=2）且带箭头指向下游', () => {
    const view = buildGraphViewModel(instance([node({ id: 'a' }), node({ id: 'b', dependsOn: ['a'] })]))
    expect(view.edges).toHaveLength(1)
    const edge = view.edges[0]
    expect(edge.source).toBe('a')
    expect(edge.target).toBe('b')
    expect(edge.style).toMatchObject({ strokeWidth: 2 })
    expect(edge.markerEnd).toBeTruthy()
  })

  it('节点 data 带卡片视图模型且宽度统一', () => {
    const view = buildGraphViewModel(
      instance([
        node({ id: 'a', type: 'AI', status: 'RUNNING', agentConfig: { acpServerType: 'opencode', modeId: null, modelId: 'gpt-4o', initNewWorktree: false } }),
      ]),
    )
    const first = view.nodes[0]
    expect(first.type).toBe('workflowNode')
    expect(first.style).toMatchObject({ width: GRAPH_NODE_WIDTH })
    expect(first.data.harness).toBe('OpenCode')
    expect(first.data.model).toBe('gpt-4o')
  })

  it('模型展示名可经映射替换，缺失时回退 modelId 原值', () => {
    const view = buildGraphViewModel(
      instance([
        node({ id: 'a', agentConfig: { acpServerType: 'opencode', modeId: null, modelId: 'gpt-4o', initNewWorktree: false } }),
      ]),
      { modelLabels: { 'gpt-4o': 'GPT-4o' } },
    )
    expect(view.nodes[0].data.model).toBe('GPT-4o')
  })

  it('人类节点可操作态判定（READY/RUNNING/REWORK）', () => {
    const view = buildGraphViewModel(
      instance([
        node({ id: 'h1', type: 'HUMAN', status: 'READY' }),
        node({ id: 'h2', type: 'HUMAN', status: 'DONE' }),
      ]),
    )
    expect(view.nodes.find((n) => n.id === 'h1')!.data.actionable).toBe(true)
    expect(view.nodes.find((n) => n.id === 'h2')!.data.actionable).toBe(false)
  })
})

describe('pickFocusWindow（执行中节点前后各 2 卡片窗口）', () => {
  /** 竖向排列 7 个节点：n1..n7（y 递增） */
  const vertical = Array.from({ length: 7 }, (_, index) => ({
    id: `n${index + 1}`,
    position: { x: 0, y: index * 150 },
  }))

  it('T-WFI1 执行中节点居中：取前后各 2 个', () => {
    expect(pickFocusWindow(vertical, ['n4'])).toEqual(['n2', 'n3', 'n4', 'n5', 'n6'])
  })

  it('T-WFI2 执行中在首/尾时索引越界自动收敛', () => {
    expect(pickFocusWindow(vertical, ['n1'])).toEqual(['n1', 'n2', 'n3'])
    expect(pickFocusWindow(vertical, ['n7'])).toEqual(['n5', 'n6', 'n7'])
  })

  it('T-WFI3 多执行中节点取布局序最靠前者作为中心', () => {
    expect(pickFocusWindow(vertical, ['n6', 'n3'])).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
  })

  it('T-WFI4 无执行中节点返回空数组', () => {
    expect(pickFocusWindow(vertical, [])).toEqual([])
    expect(pickFocusWindow(vertical, ['ghost'])).toEqual([])
  })

  it('T-WFI5 同层（y 相同）按 x 稳定排序', () => {
    const sameLayer = [
      { id: 'a', position: { x: 400, y: 0 } },
      { id: 'b', position: { x: 0, y: 0 } },
      { id: 'c', position: { x: 200, y: 0 } },
      { id: 'd', position: { x: 0, y: 150 } },
    ]
    expect(pickFocusWindow(sameLayer, ['c'], 0, 0)).toEqual(['c'])
    // 同层按 x 升序：b(x=0) < c(x=200) < a(x=400)
    expect(pickFocusWindow(sameLayer, ['c'], 1, 0)).toEqual(['b', 'c'])
    expect(pickFocusWindow(sameLayer, ['a'], 0, 1)).toEqual(['a', 'd'])
  })
})
