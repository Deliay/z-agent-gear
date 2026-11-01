import { useCallback, useEffect, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { NODE_STATUS_COLOR_VAR } from './WorkflowNodeTreeConstants'
import { GET_ACP_SERVER_OPTIONS } from '@/graphql/queries'
import type { GetAcpServerOptionsQuery } from '@/graphql/types'
import type { WorkflowInstanceData } from '@/graphql/workflow'
import WorkflowNodeCard from './graph/WorkflowNodeCard'
import { ResourceChips } from './graph/ResourceChip'
import { buildGraphViewModel, type GraphResource, type WorkflowGraphNode } from './graph/graph-layout'
import type { NodeDetailTarget } from './NodeDetailDrawer'

interface WorkflowGraphViewProps {
  instance: WorkflowInstanceData
  /** 打开节点/资源详情抽屉 */
  onOpenDetail?: (target: NodeDetailTarget) => void
  /** 详情抽屉内「打开会话」 */
  onOpenSession?: (sessionId: string) => void
}

const NODE_TYPES = { workflowNode: WorkflowNodeCard }

/**
 * 工作流图表视图：dagre TB 竖向布局、画布占满、加粗箭头连线、
 * 自定义节点卡片（状态色/动态行/token/徽标/人类操作/资源小卡片）与顶部实例资源行。
 */
export default function WorkflowGraphView({
  instance,
  onOpenDetail,
  onOpenSession,
}: WorkflowGraphViewProps) {
  const primaryAgent = instance.nodes.find(
    (node) => node.type === 'AI' && node.agentConfig?.acpServerType,
  )
  const { data: optionsData } = useQuery<GetAcpServerOptionsQuery>(GET_ACP_SERVER_OPTIONS, {
    variables: {
      controllerId: instance.controllerId,
      acpServerType: primaryAgent?.agentConfig?.acpServerType ?? '',
    },
    skip: !primaryAgent,
  })

  const modelLabels = useMemo<Record<string, string>>(() => {
    const labels: Record<string, string> = {}
    for (const model of optionsData?.acpServerOptions.models ?? []) {
      labels[model.id] = model.name
    }
    return labels
  }, [optionsData])

  const viewModel = useMemo(
    () => buildGraphViewModel(instance, { modelLabels }),
    [instance, modelLabels],
  )

  const initialNodes = useMemo<WorkflowGraphNode[]>(
    () =>
      viewModel.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onOpenDetail: (nodeId: string) => onOpenDetail?.({ type: 'node', nodeId }),
          onOpenResource: (resource: GraphResource) => onOpenDetail?.({ type: 'resource', resource }),
          onOpenSession,
        },
      })),
    [viewModel, onOpenDetail, onOpenSession],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowGraphNode>(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(viewModel.edges)

  // 当 instance 数据变化时（refetch/轮询），更新节点与边；动态行状态在卡片内部，不触发整图刷新
  useEffect(() => {
    setNodes(initialNodes)
    setEdges(viewModel.edges)
  }, [initialNodes, viewModel.edges, setNodes, setEdges])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onOpenDetail?.({ type: 'node', nodeId: node.id })
    },
    [onOpenDetail],
  )

  return (
    <div className="relative h-full min-h-[480px] w-full overflow-hidden rounded-lg border border-border">
      {viewModel.instanceResources.length > 0 && (
        <div
          data-testid="instance-resource-row"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 border-b border-border bg-background/85 px-2 py-1 backdrop-blur-xs"
        >
          <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-1">
            <span className="shrink-0 text-[10px] text-muted-foreground">实例资源</span>
            <ResourceChips
              resources={viewModel.instanceResources}
              wrap
              onOpen={(resource) => onOpenDetail?.({ type: 'resource', resource })}
            />
          </div>
        </div>
      )}
      <ReactFlow<WorkflowGraphNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        className="h-full w-full"
      >
        <Background />
        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const status = (node as WorkflowGraphNode).data?.status
            return status ? NODE_STATUS_COLOR_VAR[status] : 'var(--color-border)'
          }}
          maskColor="var(--color-muted)"
        />
      </ReactFlow>
    </div>
  )
}
