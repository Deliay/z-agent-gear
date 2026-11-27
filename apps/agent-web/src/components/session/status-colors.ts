import { SESSION_STATUS_MATRIX, sessionStatusVisual } from '@/lib/status-matrix'

/**
 * 会话状态色兼容薄层（D2）。
 *
 * 唯一映射已收敛到 `src/lib/status-matrix.ts`（规范 §2.4），本文件仅保留存量导出名，
 * 避免一次性改写全部调用方；新增代码请直接消费 `sessionStatusVisual`。
 */
export const STATUS_COLORS = Object.fromEntries(
  (Object.keys(SESSION_STATUS_MATRIX) as Array<keyof typeof SESSION_STATUS_MATRIX>).map((status) => [
    status,
    { dot: SESSION_STATUS_MATRIX[status].dot, badge: SESSION_STATUS_MATRIX[status].badge },
  ]),
) as Record<keyof typeof SESSION_STATUS_MATRIX, { dot: string; badge: string }>

export const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(SESSION_STATUS_MATRIX).map(([status, visual]) => [status, visual.label]),
)

export function getStatusDotColor(status: string): string {
  return sessionStatusVisual(status).dot
}

export function getStatusBadgeClass(status: string): string {
  return sessionStatusVisual(status).badge
}
