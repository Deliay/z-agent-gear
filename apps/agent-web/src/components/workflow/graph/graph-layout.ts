import dagre from '@dagrejs/dagre'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type {
  WorkflowInstanceData,
  WorkflowNodeData,
  WorkflowNodeStatus,
  WorkflowNodeType,
  WorkflowPullRequestLinkData,
} from '@/graphql/workflow'
import { harnessLabel } from '@/lib/harness-labels'
import { ARTIFACT_KEY_MARKER, artifactTitle, findArtifactOwner } from '@/lib/artifact-owners'
import { NODE_STATUS_COLOR_VAR } from '../WorkflowNodeTreeConstants'

/** 竖向卡片统一宽度（dagre 测量与视觉宽度一致） */
export const GRAPH_NODE_WIDTH = 280
/** 边距：并行分支横向间距 / 层级纵向间距 */
export const GRAPH_NODE_SEP = 40
export const GRAPH_RANK_SEP = 70
/** 单个节点最多可见资源小卡片数量，其余折叠为「+N」 */
export const MAX_NODE_RESOURCES = 3
export { ARTIFACT_KEY_MARKER }

export type GraphResourceKind = 'blackboard' | 'prompt' | 'pr'

export interface GraphResource {
  id: string
  kind: GraphResourceKind
  title: string
  /** 黑板产物 / 追加提示词的文本内容 */
  value: string | null
  /** PR 链接 */
  url: string | null
  /** 检查项链接（仅 PR 资源） */
  checkRunUrl: string | null
  pullRequestId: string | null
  /** 归属节点 id；null = 实例级资源行 */
  nodeId: string | null
}

export interface NodeCardViewModel {
  instanceId: string
  nodeId: string
  name: string
  type: WorkflowNodeType
  status: WorkflowNodeStatus
  stage: string
  description: string | null
  /** Harness 展示名（未知回退原值） */
  harness: string | null
  /** 模型展示名（映射失败回退 modelId 原值） */
  model: string | null
  sessionId: string | null
  reworkCount: number
  prLinks: WorkflowPullRequestLinkData[]
  hasCheckRun: boolean
  resources: GraphResource[]
  /** 超出 MAX_NODE_RESOURCES 被折叠的资源数量 */
  moreResources: number
  /** 人类节点可就地操作（READY / RUNNING / REWORK） */
  actionable: boolean
}

export interface WorkflowGraphNodeData extends NodeCardViewModel {
  /** React Flow 要求节点 data 满足可索引约束 */
  [key: string]: unknown
  onOpenDetail: (nodeId: string) => void
  onOpenResource: (resource: GraphResource) => void
  onOpenSession?: (sessionId: string) => void
}

/** React Flow 自定义节点类型（节点 data 为卡片视图模型） */
export type WorkflowGraphNode = Node<WorkflowGraphNodeData, 'workflowNode'>

export interface ResourceOwnership {
  byNode: Map<string, GraphResource[]>
  instanceResources: GraphResource[]
}

export interface GraphViewModel {
  nodes: WorkflowGraphNode[]
  edges: Edge[]
  instanceResources: GraphResource[]
}

const ACTIVE_STATUSES: WorkflowNodeStatus[] = ['RUNNING', 'REWORK']

/**
 * 资源归属纯函数：
 * - 黑板条目按 key 前缀 `{nodeId}-{nodeName}-产物-` 归属（与 `WorkflowNodeTree.artifactsOf` 同构）
 * - Pull Request 按 `pullRequestLinks[].nodeId` 精确归属
 * - 追加提示词：恰好一个 RUNNING/REWORK 节点时归属该节点，否则（多执行中/零执行中）入实例资源行
 * - 无法解析归属的一律入实例资源行（可见可点，不丢失）；`blackboardTrash` 永不渲染
 */
export function buildResourceOwnership(instance: WorkflowInstanceData): ResourceOwnership {
  const byNode = new Map<string, GraphResource[]>()
  for (const node of instance.nodes) byNode.set(node.id, [])
  const instanceResources: GraphResource[] = []
  const activeNodes = instance.nodes.filter((node) => ACTIVE_STATUSES.includes(node.status))

  for (const entry of instance.blackboard) {
    const owner = findArtifactOwner(instance.nodes, entry.key)
    const title = owner ? artifactTitle(owner, entry.key) : entry.key
    const resource: GraphResource = {
      id: `blackboard:${entry.key}`,
      kind: 'blackboard',
      title,
      value: entry.value,
      url: null,
      checkRunUrl: null,
      pullRequestId: null,
      nodeId: owner?.id ?? null,
    }
    if (owner) {
      byNode.get(owner.id)!.push(resource)
    } else {
      instanceResources.push(resource)
    }
  }

  for (const link of instance.pullRequestLinks) {
    const ownerId = byNode.has(link.nodeId) ? link.nodeId : null
    const resource: GraphResource = {
      id: `pr:${link.nodeId}:${link.pullRequestId}`,
      kind: 'pr',
      title: link.pullRequestId,
      value: null,
      url: link.prUrl,
      checkRunUrl: link.checkRunUrl,
      pullRequestId: link.pullRequestId,
      nodeId: ownerId,
    }
    if (ownerId) {
      byNode.get(ownerId)!.push(resource)
    } else {
      instanceResources.push(resource)
    }
  }

  const promptOwnerId = activeNodes.length === 1 ? activeNodes[0].id : null
  for (const prompt of instance.additionalPrompts) {
    const resource: GraphResource = {
      id: `prompt:${prompt.key}`,
      kind: 'prompt',
      title: prompt.key,
      value: prompt.value,
      url: null,
      checkRunUrl: null,
      pullRequestId: null,
      nodeId: promptOwnerId,
    }
    if (promptOwnerId) {
      byNode.get(promptOwnerId)!.push(resource)
    } else {
      instanceResources.push(resource)
    }
  }

  return { byNode, instanceResources }
}

export interface BuildNodeViewModelOptions {
  modelLabels?: Record<string, string>
}

export function toNodeCardViewModel(
  instance: WorkflowInstanceData,
  node: WorkflowNodeData,
  resources: GraphResource[],
  options: BuildNodeViewModelOptions = {},
): NodeCardViewModel {
  const prLinks = instance.pullRequestLinks.filter((link) => link.nodeId === node.id)
  const modelId = node.agentConfig?.modelId ?? null
  return {
    instanceId: instance.id,
    nodeId: node.id,
    name: node.name,
    type: node.type,
    status: node.status,
    stage: node.stage,
    description: node.description,
    harness: node.agentConfig?.acpServerType ? harnessLabel(node.agentConfig.acpServerType) : null,
    model: modelId ? (options.modelLabels?.[modelId] ?? modelId) : null,
    sessionId: node.sessionId,
    reworkCount: node.reworkCount,
    prLinks,
    hasCheckRun: prLinks.some((link) => Boolean(link.checkRunUrl)),
    resources: resources.slice(0, MAX_NODE_RESOURCES),
    moreResources: Math.max(0, resources.length - MAX_NODE_RESOURCES),
    actionable:
      node.type === 'HUMAN' &&
      (node.status === 'READY' || node.status === 'RUNNING' || node.status === 'REWORK'),
  }
}

/** 卡片高度分档估算（±20px 可接受，dagre 间距已留余量） */
export function estimateNodeHeight(viewModel: Pick<
  NodeCardViewModel,
  'type' | 'status' | 'sessionId' | 'actionable' | 'resources' | 'moreResources'
>): number {
  let height = 104
  if (viewModel.type === 'AI') height += 26
  if (viewModel.type === 'AI' && viewModel.status === 'DONE') height += 24
  if (viewModel.type === 'AI' && ACTIVE_STATUSES.includes(viewModel.status)) height += 26
  if (viewModel.resources.length > 0 || viewModel.moreResources > 0) height += 44
  if (viewModel.actionable) height += 104
  return Math.min(260, Math.max(120, height))
}

export interface LayoutInput {
  id: string
  dependsOn: string[]
  height: number
}

/** dagre 竖向布局（rankdir TB）：返回每个节点的左上角坐标 */
export function layoutGraphNodes(inputs: LayoutInput[]): Map<string, { x: number; y: number; height: number }> {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'TB', nodesep: GRAPH_NODE_SEP, ranksep: GRAPH_RANK_SEP })

  const known = new Set(inputs.map((input) => input.id))
  for (const input of inputs) {
    graph.setNode(input.id, { width: GRAPH_NODE_WIDTH, height: input.height })
  }
  for (const input of inputs) {
    for (const dependency of input.dependsOn) {
      if (known.has(dependency)) graph.setEdge(dependency, input.id)
    }
  }

  dagre.layout(graph)

  const positions = new Map<string, { x: number; y: number; height: number }>()
  for (const input of inputs) {
    const position = graph.node(input.id)
    positions.set(input.id, {
      x: position.x - GRAPH_NODE_WIDTH / 2,
      y: position.y - input.height / 2,
      height: input.height,
    })
  }
  return positions
}

function buildEdges(instance: WorkflowInstanceData): Edge[] {
  const known = new Set(instance.nodes.map((node) => node.id))
  const edges: Edge[] = []
  for (const node of instance.nodes) {
    for (const dependency of node.dependsOn) {
      if (!known.has(dependency)) continue
      const color =
        node.status === 'RUNNING'
          ? NODE_STATUS_COLOR_VAR.RUNNING
          : 'var(--color-border)'
      edges.push({
        id: `${dependency}->${node.id}`,
        source: dependency,
        target: node.id,
        type: 'smoothstep',
        animated: node.status === 'RUNNING',
        style: { stroke: color, strokeWidth: 2 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color,
        },
      })
    }
  }
  return edges
}

/**
 * 构建图表视图模型：节点卡片视图模型 + dagre TB 坐标 + 加粗箭头连线 + 实例级资源行。
 */
export function buildGraphViewModel(
  instance: WorkflowInstanceData,
  options: { modelLabels?: Record<string, string> } = {},
): GraphViewModel {
  const ownership = buildResourceOwnership(instance)
  const viewModels = instance.nodes.map((node) =>
    toNodeCardViewModel(instance, node, ownership.byNode.get(node.id) ?? [], options),
  )
  const heights = new Map(viewModels.map((viewModel) => [viewModel.nodeId, estimateNodeHeight(viewModel)]))
  const positions = layoutGraphNodes(
    instance.nodes.map((node) => ({
      id: node.id,
      dependsOn: node.dependsOn,
      height: heights.get(node.id) ?? 140,
    })),
  )

  const nodes: WorkflowGraphNode[] = instance.nodes.map((node) => {
    const viewModel = viewModels.find((candidate) => candidate.nodeId === node.id)!
    const position = positions.get(node.id)!
    return {
      id: node.id,
      type: 'workflowNode',
      position: { x: position.x, y: position.y },
      data: {
        ...viewModel,
        onOpenDetail: () => {},
        onOpenResource: () => {},
      },
      width: GRAPH_NODE_WIDTH,
      style: { width: GRAPH_NODE_WIDTH },
    }
  })

  return {
    nodes,
    edges: buildEdges(instance),
    instanceResources: ownership.instanceResources,
  }
}
