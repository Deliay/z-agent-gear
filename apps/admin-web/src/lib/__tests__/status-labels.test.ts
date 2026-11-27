import { describe, expect, it } from 'vitest'
import { statusBadgeProps, statusLabel } from '../status-labels'

describe('状态徽标统一映射', () => {
  it('T-AUI-ST1: 同一状态键恒返回同一 Badge 变体与文案', () => {
    expect(statusBadgeProps('INITIALIZING')).toEqual({
      label: '初始化中',
      variant: 'warning',
      tone: 'warning',
    })
    expect(statusBadgeProps('ONLINE').variant).toBe('success')
    expect(statusBadgeProps('FAILED')).toEqual({
      label: '失败',
      variant: 'destructive',
      tone: 'destructive',
    })
    expect(statusBadgeProps('recharge')).toEqual({
      label: '入账',
      variant: 'success',
      tone: 'success',
    })
    expect(statusBadgeProps('deduction').variant).toBe('muted')
    expect(statusBadgeProps('admin').variant).toBe('default')
    expect(statusBadgeProps('developer').variant).toBe('muted')
    expect(statusBadgeProps('team').variant).toBe('default')
    expect(statusBadgeProps('personal').variant).toBe('info')
    expect(statusLabel('SUCCESS')).toBe('成功')
  })

  it('T-AUI-ST1: 未知键回落 muted 且不抛错', () => {
    expect(() => statusBadgeProps('NEW_BACKEND_STATUS')).not.toThrow()
    expect(statusBadgeProps('NEW_BACKEND_STATUS')).toEqual({
      label: 'NEW_BACKEND_STATUS',
      variant: 'muted',
      tone: 'muted',
    })
    expect(statusBadgeProps(null)).toEqual({ label: '-', variant: 'muted', tone: 'muted' })
    expect(statusBadgeProps('unknown', '未知')).toEqual({
      label: '未知',
      variant: 'muted',
      tone: 'muted',
    })
  })
})
