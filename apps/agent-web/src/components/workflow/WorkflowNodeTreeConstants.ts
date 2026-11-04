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
  RETRY_FAILED: '重试失败',
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
  // 自动重试用尽：与 FAILED 同族破坏色，文案区分「重试失败」
  RETRY_FAILED: {
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
  RETRY_FAILED: 'var(--color-destructive)',
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

/** 中断自动重试预算（与 agent-api `INTERRUPT_RETRY_MAX` 对齐） */
export const WORKFLOW_INTERRUPT_RETRY_MAX = 10

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 自动重试进度文案（三态，纯函数便于单测）：
 * - `nextRetryAt === null`：无排期（已发送/未排期）→ 不展示；
 * - 未来：`自动重试 {n}/10 · 下次 HH:mm`；
 * - 已过期：会话恢复中 → `自动重试 {n}/10 · 正在恢复会话`。
 */
export function retryProgressText(
  node: { retryCount: number; nextRetryAt: string | null },
  now: Date = new Date(),
): string | null {
  if (!node.nextRetryAt) return null
  const next = new Date(node.nextRetryAt)
  if (Number.isNaN(next.getTime())) return null
  const count = `自动重试 ${node.retryCount}/${WORKFLOW_INTERRUPT_RETRY_MAX}`
  if (next.getTime() > now.getTime()) {
    return `${count} · 下次 ${pad2(next.getHours())}:${pad2(next.getMinutes())}`
  }
  return `${count} · 正在恢复会话`
}
