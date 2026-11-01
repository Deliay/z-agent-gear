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

/**
 * 节点状态语义配色单一来源（PRD 功能点 11）。
 *
 * - `spine`：卡片左侧色脊（4px）
 * - `tint` ：卡片淡底
 * - `badge`：状态徽标
 *
 * 语义表：RUNNING→info、DONE→success、REJECT→warning（静态琥珀）、
 * REWORK→warning（琥珀 + 脉冲底纹，与 REJECT 双重区分）、FAILED→destructive、
 * INITIALIZING/READY→muted。全部走 `index.css` 的 oklch 语义变量，无固定色值。
 */
export const NODE_STATUS_VISUAL: Record<
  WorkflowNodeStatus,
  { spine: string; tint: string; badge: string }
> = {
  INITIALIZING: {
    spine: 'bg-muted-foreground/40',
    tint: 'bg-muted/30',
    badge: 'bg-muted text-muted-foreground',
  },
  READY: {
    spine: 'bg-border',
    tint: 'bg-muted/20',
    badge: 'bg-muted text-muted-foreground',
  },
  RUNNING: {
    spine: 'bg-info',
    tint: 'bg-info/10',
    badge: 'bg-info/15 text-info',
  },
  DONE: {
    spine: 'bg-success',
    tint: 'bg-success/10',
    badge: 'bg-success/15 text-success',
  },
  REJECT: {
    spine: 'bg-warning',
    tint: 'bg-warning/10',
    badge: 'bg-warning/15 text-warning',
  },
  REWORK: {
    spine: 'bg-warning animate-pulse',
    tint: 'bg-warning/10',
    badge: 'bg-warning/15 text-warning animate-pulse',
  },
  FAILED: {
    spine: 'bg-destructive',
    tint: 'bg-destructive/10',
    badge: 'bg-destructive/15 text-destructive',
  },
}

/** 状态 → 语义色 CSS 变量（Canvas / MiniMap / 连线等无法使用 Tailwind 类的场景） */
export const NODE_STATUS_COLOR_VAR: Record<WorkflowNodeStatus, string> = {
  INITIALIZING: 'var(--color-muted-foreground)',
  READY: 'var(--color-border)',
  RUNNING: 'var(--color-info)',
  DONE: 'var(--color-success)',
  REJECT: 'var(--color-warning)',
  REWORK: 'var(--color-warning)',
  FAILED: 'var(--color-destructive)',
}

/** 兼容存量调用方的导出名：徽标类值取自语义映射 `badge` 段 */
export const NODE_STATUS_BADGE: Record<WorkflowNodeStatus, string> = Object.fromEntries(
  (Object.keys(NODE_STATUS_VISUAL) as WorkflowNodeStatus[]).map((status) => [
    status,
    NODE_STATUS_VISUAL[status].badge,
  ]),
) as Record<WorkflowNodeStatus, string>

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
