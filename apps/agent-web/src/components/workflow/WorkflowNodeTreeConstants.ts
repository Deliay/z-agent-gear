import type { WorkflowNodeStatus, WorkflowNodeType } from '@/graphql/workflow'
import {
  WORKFLOW_NODE_COLOR_VAR,
  WORKFLOW_NODE_STATUS_MATRIX,
} from '@/lib/status-matrix'

export const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  HUMAN: '人类',
  AI: 'AI',
  FLAG: '旗帜',
}

/** 节点状态文案：唯一来源 `src/lib/status-matrix.ts`（D2） */
export const NODE_STATUS_LABELS: Record<WorkflowNodeStatus, string> = Object.fromEntries(
  (Object.keys(WORKFLOW_NODE_STATUS_MATRIX) as WorkflowNodeStatus[]).map((status) => [
    status,
    WORKFLOW_NODE_STATUS_MATRIX[status].label,
  ]),
) as Record<WorkflowNodeStatus, string>

/**
 * 节点状态语义配色单一来源（PRD 功能点 11 / D2）。
 *
 * - `spine`：卡片左侧色脊（4px）/ 顶部状态条
 * - `tint` ：卡片底色（统一不透明 `bg-card`，避免半透明导致卡片与画布底色混叠）
 * - `badge`：状态徽标
 *
 * 取值全部来自 `src/lib/status-matrix.ts`（规范 §2.4）；本常量仅保留存量导出名。
 */
export const NODE_STATUS_VISUAL: Record<
  WorkflowNodeStatus,
  { spine: string; tint: string; badge: string }
> = Object.fromEntries(
  (Object.keys(WORKFLOW_NODE_STATUS_MATRIX) as WorkflowNodeStatus[]).map((status) => {
    const visual = WORKFLOW_NODE_STATUS_MATRIX[status]
    return [status, { spine: visual.spine, tint: visual.tint, badge: visual.badge }]
  }),
) as Record<WorkflowNodeStatus, { spine: string; tint: string; badge: string }>

/** 状态 → 语义色 CSS 变量（Canvas / MiniMap / 连线等无法使用 Tailwind 类的场景） */
export const NODE_STATUS_COLOR_VAR: Record<WorkflowNodeStatus, string> = WORKFLOW_NODE_COLOR_VAR

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

/** 失败来源 → 中文文案（未知值原样返回，防御旧服务端/新来源） */
export const FAIL_SOURCE_LABELS: Record<string, string> = {
  SESSION_STUCK: '会话停滞',
  LLM_REPORTED: 'AI 主动标记',
  SESSION_START_FAILED: '会话启动失败',
  RETRY_EXHAUSTED: '中断重试用尽',
  CONTROLLER_UNAVAILABLE: '控制器不可用',
  MANUAL: '人工标记',
}

export function failSourceText(source: string): string {
  return FAIL_SOURCE_LABELS[source] ?? source
}


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
