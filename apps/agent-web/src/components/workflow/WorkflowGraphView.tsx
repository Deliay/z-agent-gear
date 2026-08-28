import { useMemo, useCallback, useEffect } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import '@xyflow/react/dist/style.css'
import { NODE_STATUS_LABELS } from './WorkflowNodeTreeConstants'
import type { WorkflowNodeData, WorkflowInstanceData } from '@/graphql/workflow'

interface WorkflowGraphViewProps {
  instance: WorkflowInstanceData
  onNodeClick?: (nodeId: string) => void
}

const NODE_TYPE_LABELS: Record<string, string> = {
  HUMAN: '人类',
  AI: 'AI',
  FLAG: '旗帜',
}

const STATUS_COLORS: Record<string, string> = {
  INITIALIZING: '#94a3b8',
  READY: '#3b82f6',
  RUNNING: '#22c55e',
  DONE: '#10b981',
  REJECT: '#f59e0b',
  REWORK: '#f97316',
  FAILED: '#ef4444',
}

function getStatusColor(status: string): string {
  return STATUS_COLORS[status] || '#94a3b8'
}

function buildGraph(instance: WorkflowInstanceData): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 80 })

  const nodeMap = new Map<string, WorkflowNodeData>()
  for (const node of instance.nodes) {
    nodeMap.set(node.id, node)
    g.setNode(node.id, { width: 180, height: 60 })
  }

  const edges: Edge[] = []
  for (const node of instance.nodes) {
    for (const depId of node.dependsOn) {
      if (nodeMap.has(depId)) {
        g.setEdge(depId, node.id)
        edges.push({
          id: `${depId}->${node.id}`,
          source: depId,
          target: node.id,
          animated: node.status === 'RUNNING',
          style: { stroke: '#94a3b8' },
        })
      }
    }
  }

  dagre.layout(g)

  const nodes: Node[] = instance.nodes.map((node) => {
    const pos = g.node(node.id)
    return {
      id: node.id,
      position: { x: pos.x - 90, y: pos.y - 30 },
      data: {
        label: (
          <div className="flex flex-col items-center gap-1">
            <div className="text-xs font-semibold">{node.name}</div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">{NODE_TYPE_LABELS[node.type]}</span>
              {node.agentConfig?.acpServerType && (
                <span className="rounded bg-primary/20 px-1 text-[10px] text-primary">
                  {node.agentConfig.acpServerType}
                </span>
              )}
            </div>
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: getStatusColor(node.status) }}
            >
              {NODE_STATUS_LABELS[node.status]}
            </span>
          </div>
        ),
      },
      style: {
        border: `2px solid ${getStatusColor(node.status)}`,
        borderRadius: '8px',
        background: 'white',
        padding: '8px',
        width: 180,
      },
    }
  })

  return { nodes, edges }
}

export default function WorkflowGraphView({ instance, onNodeClick }: WorkflowGraphViewProps) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildGraph(instance),
    [instance],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // 当 instance 数据变化时（refetch/轮询），更新节点和边的状态
  useEffect(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
  }, [initialNodes, initialEdges, setNodes, setEdges])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (onNodeClick) {
        onNodeClick(node.id)
      }
    },
    [onNodeClick],
  )

  return (
    <div className="h-[600px] w-full rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        fitView
        attributionPosition="bottom-left"
      >
        <Background />
        <Controls />
        <MiniMap
          nodeColor={(node) => {
            const status = instance.nodes.find((n) => n.id === node.id)?.status
            return status ? getStatusColor(status) : '#94a3b8'
          }}
          maskColor="rgba(0, 0, 0, 0.1)"
        />
      </ReactFlow>
    </div>
  )
}
