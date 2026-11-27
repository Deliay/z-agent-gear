import type { CloudHostStatus } from '@/graphql/types'
import type { WorkflowNodeStatus } from '@/graphql/workflow'

/**
 * 跨领域状态语义矩阵：会话 / 云电脑 / 工作流节点的状态 → 视觉与文案唯一映射。
 *
 * 设计依据：`docs/engineering/prototypes/20261127-ui-specification.md` §2.4
 * 与实现计划裁决 D2（多领域状态口径收敛为单一实现，`session/status-colors.ts`、
 * `workflow/WorkflowNodeTreeConstants.ts`、`cloud-host/cloud-host-status.ts`
 * 均改为消费本模块，禁止各自维护第二套取色口径）。
 *
 * 视觉约定：
 * - `dot`  ：状态指示圆点（展示型列表、状态行）
 * - `badge`：状态徽标底色 + 文字色（胶囊徽标）
 * - `label`：统一中文文案
 *
 * 全部取值只允许使用 `index.css` 中的 OKLCH 语义 Token
 * （`success` / `warning` / `info` / `destructive` / `muted`），禁止硬编码调色板色值。
 */

/** 会话状态（与 agent-api Session.status 取值对齐） */
export type SessionStatusValue =
  | 'creating'
  | 'connecting'
  | 'idling'
  | 'running'
  | 'disconnected'
  | 'ended'

export interface StatusVisual {
  /** 状态指示圆点类 */
  dot: string
  /** 状态徽标类（底色 + 文字色） */
  badge: string
  /** 统一中文文案 */
  label: string
}

/** 工作流节点视觉额外包含卡片色脊与底色 */
export interface WorkflowNodeStatusVisual extends StatusVisual {
  /** 卡片左侧 4px 语义色脊 / 顶部状态条 */
  spine: string
  /** 卡片底色（统一不透明，避免与画布混叠） */
  tint: string
}

/** 未知状态的兜底视觉：中性灰，绝不继承任意领域的语义色 */
export const STATUS_FALLBACK: StatusVisual = {
  dot: 'bg-muted-foreground',
  badge: 'bg-muted text-muted-foreground',
  label: '',
}

/** 规范 §2.4：会话 6 态 */
export const SESSION_STATUS_MATRIX: Record<SessionStatusValue, StatusVisual> = {
  creating: {
    dot: 'bg-warning animate-pulse',
    badge: 'bg-warning/15 text-warning-text',
    label: '创建中',
  },
  connecting: {
    dot: 'bg-warning animate-pulse',
    badge: 'bg-warning/15 text-warning-text',
    label: '连接中',
  },
  idling: {
    dot: 'bg-success',
    badge: 'bg-success/15 text-success-text',
    label: '空闲',
  },
  running: {
    dot: 'bg-info animate-pulse',
    badge: 'bg-info/15 text-info-text animate-pulse',
    label: '工作中',
  },
  disconnected: {
    dot: 'bg-destructive',
    badge: 'bg-destructive/15 text-destructive',
    label: '已断连',
  },
  ended: {
    dot: 'bg-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
    label: '已结束',
  },
}

/** 规范 §2.4：云电脑 5 态 */
export const CLOUD_HOST_STATUS_MATRIX: Record<CloudHostStatus, StatusVisual> = {
  STARTING: {
    dot: 'bg-warning animate-pulse',
    badge: 'bg-warning/15 text-warning-text',
    label: '启动中',
  },
  RUNNING: {
    dot: 'bg-success',
    badge: 'bg-success/15 text-success-text',
    label: '运行中',
  },
  STOPPING: {
    dot: 'bg-warning animate-pulse',
    badge: 'bg-warning/15 text-warning-text',
    label: '停止中',
  },
  STOPPED: {
    dot: 'bg-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
    label: '已销毁',
  },
  FAILED: {
    dot: 'bg-destructive',
    badge: 'bg-destructive/15 text-destructive',
    label: '失败',
  },
}

/**
 * 工作流节点 8 态（规范 §2.4 的 6 个语义态 + D2 扩展态）：
 * - `REJECT` 并入 warning（静态琥珀，与 REWORK 的脉冲区分）
 * - `RETRY_FAILED` 并入 destructive
 * - `INITIALIZING` / `READY` 并入 muted-foreground（未开始）
 */
export const WORKFLOW_NODE_STATUS_MATRIX: Record<WorkflowNodeStatus, WorkflowNodeStatusVisual> = {
  INITIALIZING: {
    dot: 'bg-muted-foreground/40',
    badge: 'bg-muted text-muted-foreground',
    label: '等待中',
    spine: 'bg-muted-foreground/40',
    tint: 'bg-card',
  },
  READY: {
    dot: 'bg-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
    label: '待开始',
    spine: 'bg-border',
    tint: 'bg-card',
  },
  RUNNING: {
    dot: 'bg-info animate-pulse',
    badge: 'bg-info/15 text-info-text',
    label: '执行中',
    spine: 'bg-info',
    tint: 'bg-card',
  },
  DONE: {
    dot: 'bg-success',
    badge: 'bg-success/15 text-success-text',
    label: '已完成',
    spine: 'bg-success',
    tint: 'bg-card',
  },
  REJECT: {
    dot: 'bg-warning',
    badge: 'bg-warning/15 text-warning-text',
    label: '已打回',
    spine: 'bg-warning',
    tint: 'bg-card',
  },
  REWORK: {
    dot: 'bg-warning animate-pulse',
    badge: 'bg-warning/15 text-warning-text animate-pulse',
    label: '返工中',
    spine: 'bg-warning animate-pulse',
    tint: 'bg-card',
  },
  FAILED: {
    dot: 'bg-destructive',
    badge: 'bg-destructive/15 text-destructive',
    label: '失败',
    spine: 'bg-destructive',
    tint: 'bg-card',
  },
  RETRY_FAILED: {
    dot: 'bg-destructive',
    badge: 'bg-destructive/15 text-destructive',
    label: '重试失败',
    spine: 'bg-destructive',
    tint: 'bg-card',
  },
}

/** 未知状态兜底视觉（T-SMX2）：中性灰，不继承任何领域语义色 */
export function workflowNodeFallback(): WorkflowNodeStatusVisual {
  return { ...STATUS_FALLBACK, spine: 'bg-border', tint: 'bg-card' }
}

export function sessionStatusVisual(status: string): StatusVisual {
  return SESSION_STATUS_MATRIX[status as SessionStatusValue] ?? STATUS_FALLBACK
}

export function cloudHostStatusVisual(status?: CloudHostStatus | string | null): StatusVisual {
  if (!status) return STATUS_FALLBACK
  return CLOUD_HOST_STATUS_MATRIX[status as CloudHostStatus] ?? { ...STATUS_FALLBACK, label: status }
}

export function workflowNodeStatusVisual(status: string): WorkflowNodeStatusVisual {
  return WORKFLOW_NODE_STATUS_MATRIX[status as WorkflowNodeStatus] ?? workflowNodeFallback()
}

/** 状态 → 语义色 CSS 变量（Canvas / MiniMap / 连线等无法使用 Tailwind 类的场景） */
export const WORKFLOW_NODE_COLOR_VAR: Record<WorkflowNodeStatus, string> = {
  INITIALIZING: 'var(--color-muted-foreground)',
  READY: 'var(--color-border)',
  RUNNING: 'var(--color-info)',
  DONE: 'var(--color-success)',
  REJECT: 'var(--color-warning)',
  REWORK: 'var(--color-warning)',
  FAILED: 'var(--color-destructive)',
  RETRY_FAILED: 'var(--color-destructive)',
}
