import type { WorkflowNodeStatus, WorkflowNodeType } from '@/graphql/workflow'

export const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  HUMAN: '人类',
  AI: 'AI',
  FLAG: '旗帜',
}

export const NODE_STATUS_LABELS: Record<WorkflowNodeStatus, string> = {
  INITIALIZING: '等待中',
  READY: '待开始',
  RUNNING: '执行中',
  DONE: '已完成',
  REJECT: '已打回',
  REWORK: '返工中',
  FAILED: '失败',
}

export const NODE_STATUS_BADGE: Record<WorkflowNodeStatus, string> = {
  INITIALIZING: 'bg-warning/15 text-warning',
  READY: 'bg-muted text-muted-foreground',
  RUNNING: 'bg-info/15 text-info',
  DONE: 'bg-success/15 text-success',
  REJECT: 'bg-destructive/15 text-destructive',
  REWORK: 'bg-warning/15 text-warning',
  FAILED: 'bg-destructive/15 text-destructive',
}

export function instanceStatusText(instance: {
  currentNodeNames: string[]
  lastNodeName: string | null
  lastNodeStatus: WorkflowNodeStatus | null
}): string {
  if (instance.currentNodeNames.length > 0) {
    return `执行中：${instance.currentNodeNames.join('、')}`
  }
  if (instance.lastNodeName && instance.lastNodeStatus) {
    return `${instance.lastNodeName} · ${NODE_STATUS_LABELS[instance.lastNodeStatus]}`
  }
  return '暂无执行中的节点'
}
