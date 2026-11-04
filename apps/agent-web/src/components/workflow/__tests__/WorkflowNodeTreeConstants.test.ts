import { describe, expect, it } from 'vitest'
import {
  NODE_STATUS_BADGE,
  NODE_STATUS_COLOR_VAR,
  NODE_STATUS_LABELS,
  NODE_STATUS_VISUAL,
  retryProgressText,
} from '../WorkflowNodeTreeConstants'
import type { WorkflowNodeStatus } from '@/graphql/workflow'

const STATUSES: WorkflowNodeStatus[] = [
  'INITIALIZING',
  'READY',
  'RUNNING',
  'DONE',
  'REJECT',
  'REWORK',
  'FAILED',
  'RETRY_FAILED',
]

describe('NODE_STATUS_VISUAL', () => {
  it('T-UI4-TC1 七态映射齐全且三段色均非空', () => {
    for (const status of STATUSES) {
      const visual = NODE_STATUS_VISUAL[status]
      expect(visual.spine).toBeTruthy()
      expect(visual.tint).toBeTruthy()
      expect(visual.badge).toBeTruthy()
      expect(NODE_STATUS_LABELS[status]).toBeTruthy()
      expect(NODE_STATUS_COLOR_VAR[status]).toMatch(/^var\(--color-/)
    }
  })

  it('T-UI4-TC2 REJECT 与 FAILED 色类不同（可一眼区分）', () => {
    expect(NODE_STATUS_VISUAL.REJECT.spine).not.toBe(NODE_STATUS_VISUAL.FAILED.spine)
    expect(NODE_STATUS_VISUAL.REJECT.badge).not.toBe(NODE_STATUS_VISUAL.FAILED.badge)
    expect(NODE_STATUS_VISUAL.REJECT.badge).toContain('warning')
    expect(NODE_STATUS_VISUAL.FAILED.badge).toContain('destructive')
  })

  it('T-UI4-TC3 REWORK 含脉冲动效，REJECT 为静态', () => {
    expect(NODE_STATUS_VISUAL.REWORK.badge).toContain('animate-pulse')
    expect(NODE_STATUS_VISUAL.REWORK.spine).toContain('animate-pulse')
    expect(NODE_STATUS_VISUAL.REJECT.badge).not.toContain('animate-pulse')
  })

  it('T-UI4-TC4 NODE_STATUS_BADGE 导出兼容（取自 badge 段）', () => {
    for (const status of STATUSES) {
      expect(NODE_STATUS_BADGE[status]).toBe(NODE_STATUS_VISUAL[status].badge)
    }
  })

  it('六态主色互异（INITIALIZING/READY 为中性色域）', () => {
    const primary = [
      NODE_STATUS_VISUAL.RUNNING.spine,
      NODE_STATUS_VISUAL.DONE.spine,
      NODE_STATUS_VISUAL.REJECT.spine,
      NODE_STATUS_VISUAL.FAILED.spine,
    ]
    expect(new Set(primary).size).toBe(primary.length)
  })
})

describe('RETRY_FAILED 与自动重试进度（T-FE1）', () => {
  it('T-FE1a: 标签「重试失败」，三张映射全覆盖且徽标派生不缺失', () => {
    expect(NODE_STATUS_LABELS.RETRY_FAILED).toBe('重试失败')
    for (const mapping of [NODE_STATUS_VISUAL, NODE_STATUS_COLOR_VAR, NODE_STATUS_BADGE, NODE_STATUS_LABELS]) {
      expect(mapping.RETRY_FAILED).toBeTruthy()
    }
    expect(NODE_STATUS_VISUAL.RETRY_FAILED.badge).toContain('destructive')
    expect(NODE_STATUS_COLOR_VAR.RETRY_FAILED).toBe('var(--color-destructive)')
  })

  it('T-FE1b: retryProgressText 三态：无排期不展示 / 未来 HH:mm / 已过期恢复中', () => {
    expect(retryProgressText({ retryCount: 2, nextRetryAt: null })).toBeNull()

    const now = new Date('2026-11-03T10:00:00')
    expect(
      retryProgressText({ retryCount: 2, nextRetryAt: new Date('2026-11-03T10:01:00').toISOString() }, now),
    ).toBe('自动重试 2/10 · 下次 10:01')
    expect(
      retryProgressText({ retryCount: 3, nextRetryAt: new Date('2026-11-03T09:59:00').toISOString() }, now),
    ).toBe('自动重试 3/10 · 正在恢复会话')
  })

  it('T-FE1c: 非法时间串不展示', () => {
    expect(retryProgressText({ retryCount: 1, nextRetryAt: 'not-a-date' })).toBeNull()
  })
})
