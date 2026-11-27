import { describe, expect, it } from 'vitest'
import {
  CLOUD_HOST_STATUS_MATRIX,
  SESSION_STATUS_MATRIX,
  STATUS_FALLBACK,
  WORKFLOW_NODE_COLOR_VAR,
  WORKFLOW_NODE_STATUS_MATRIX,
  cloudHostStatusVisual,
  sessionStatusVisual,
  workflowNodeStatusVisual,
} from '../status-matrix'

const PALETTE_REGEX =
  /(?:text|bg|border|ring|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/

describe('跨领域状态色矩阵（规范 §2.4，D2）', () => {
  it('T-SMX1a: 会话全状态均在矩阵内且 dot/badge/文案与规范一致', () => {
    const expectations = {
      creating: { dot: 'bg-warning animate-pulse', badge: 'bg-warning/15 text-warning', label: '创建中' },
      connecting: { dot: 'bg-warning animate-pulse', badge: 'bg-warning/15 text-warning', label: '连接中' },
      idling: { dot: 'bg-success', badge: 'bg-success/15 text-success', label: '空闲' },
      running: { dot: 'bg-info animate-pulse', badge: 'bg-info/15 text-info animate-pulse', label: '工作中' },
      disconnected: { dot: 'bg-destructive', badge: 'bg-destructive/15 text-destructive', label: '已断连' },
      ended: { dot: 'bg-muted-foreground', badge: 'bg-muted text-muted-foreground', label: '已结束' },
    } as const

    for (const [status, expected] of Object.entries(expectations)) {
      expect(SESSION_STATUS_MATRIX[status as keyof typeof SESSION_STATUS_MATRIX]).toMatchObject(expected)
    }
    expect(Object.keys(SESSION_STATUS_MATRIX)).toHaveLength(Object.keys(expectations).length)
  })

  it('T-SMX1b: 云电脑全状态均在矩阵内且 dot/badge/文案与规范一致', () => {
    const expectations = {
      STARTING: { dot: 'bg-warning animate-pulse', badge: 'bg-warning/15 text-warning', label: '启动中' },
      RUNNING: { dot: 'bg-success', badge: 'bg-success/15 text-success', label: '运行中' },
      STOPPING: { dot: 'bg-warning animate-pulse', badge: 'bg-warning/15 text-warning', label: '停止中' },
      STOPPED: { dot: 'bg-muted-foreground', badge: 'bg-muted text-muted-foreground', label: '已销毁' },
      FAILED: { dot: 'bg-destructive', badge: 'bg-destructive/15 text-destructive', label: '失败' },
    } as const

    for (const [status, expected] of Object.entries(expectations)) {
      expect(CLOUD_HOST_STATUS_MATRIX[status as keyof typeof CLOUD_HOST_STATUS_MATRIX]).toMatchObject(expected)
    }
  })

  it('T-SMX1c: 工作流节点 8 态齐全，扩展态按语义并入（REJECT→warning / RETRY_FAILED→destructive）', () => {
    const statuses = [
      'INITIALIZING',
      'READY',
      'RUNNING',
      'DONE',
      'REJECT',
      'REWORK',
      'FAILED',
      'RETRY_FAILED',
    ] as const

    for (const status of statuses) {
      const visual = WORKFLOW_NODE_STATUS_MATRIX[status]
      expect(visual.dot).toBeTruthy()
      expect(visual.badge).toBeTruthy()
      expect(visual.label).toBeTruthy()
      expect(visual.spine).toBeTruthy()
      expect(visual.tint).toBe('bg-card')
      expect(WORKFLOW_NODE_COLOR_VAR[status]).toMatch(/^var\(--color-/)
    }

    expect(WORKFLOW_NODE_STATUS_MATRIX.REJECT.badge).toContain('warning')
    expect(WORKFLOW_NODE_STATUS_MATRIX.REWORK.badge).toContain('warning')
    expect(WORKFLOW_NODE_STATUS_MATRIX.REWORK.badge).toContain('animate-pulse')
    expect(WORKFLOW_NODE_STATUS_MATRIX.FAILED.badge).toContain('destructive')
    expect(WORKFLOW_NODE_STATUS_MATRIX.RETRY_FAILED.badge).toContain('destructive')
    expect(WORKFLOW_NODE_STATUS_MATRIX.INITIALIZING.badge).toContain('muted')
    expect(WORKFLOW_NODE_STATUS_MATRIX.READY.badge).toContain('muted')
  })

  it('T-SMX1d: 矩阵内全部类名只使用语义 Token，禁止硬编码调色板色值', () => {
    const allClasses = [
      ...Object.values(SESSION_STATUS_MATRIX),
      ...Object.values(CLOUD_HOST_STATUS_MATRIX),
      ...Object.values(WORKFLOW_NODE_STATUS_MATRIX),
    ].flatMap((visual) => [visual.dot, visual.badge, ...('spine' in visual ? [visual.spine] : [])])

    for (const className of allClasses) {
      expect(className).not.toMatch(PALETTE_REGEX)
    }
  })

  it('T-SMX2: 未知状态回退 muted-foreground（不继承语义色）', () => {
    expect(sessionStatusVisual('unknown-status')).toEqual(STATUS_FALLBACK)
    expect(cloudHostStatusVisual('UNKNOWN')).toMatchObject({
      dot: 'bg-muted-foreground',
      badge: 'bg-muted text-muted-foreground',
    })
    expect(workflowNodeStatusVisual('LEGACY_STATE')).toMatchObject({
      dot: 'bg-muted-foreground',
      badge: 'bg-muted text-muted-foreground',
    })
    expect(STATUS_FALLBACK.dot).toBe('bg-muted-foreground')
  })
})
