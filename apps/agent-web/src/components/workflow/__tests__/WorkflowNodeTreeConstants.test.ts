import { describe, expect, it } from 'vitest'
import {
  NODE_STATUS_BADGE,
  NODE_STATUS_COLOR_VAR,
  NODE_STATUS_LABELS,
  NODE_STATUS_VISUAL,
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

  it('T-WFI-TC1 七态 tint 统一不透明 bg-card（无透明度后缀）', () => {
    for (const status of STATUSES) {
      expect(NODE_STATUS_VISUAL[status].tint).toBe('bg-card')
      expect(NODE_STATUS_VISUAL[status].tint).not.toMatch(/\/\d+/)
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
