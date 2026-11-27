import { describe, expect, it } from 'vitest'
import { statusBadgeProps, statusLabel } from '../status-labels'

/**
 * 契约枚举覆盖（T-AUI-ST1）：
 * - 云端容器 `CloudContainerStatus` 七态（contracts/admin-cloud-container.graphql）；
 * - 工作负载日志 `CloudWorkloadLogStatus` 五态（contracts/admin-cloud-workload.graphql）；
 * - 计费 `BillingLedgerType` recharge | charge | adjust（contracts/admin-billing.graphql）；
 * - 模型调用 `BillingApiCall.status` started | completed | aborted | failed。
 */
const CONTRACT_STATUS_CASES: Array<[status: string, label: string, variant: string]> = [
  // 云端容器七态
  ['CREATING', '创建中', 'warning'],
  ['CONNECTING', '连接中', 'warning'],
  ['INITIALIZING', '初始化中', 'warning'],
  ['ONLINE', '在线', 'success'],
  ['DESTROYING', '销毁中', 'warning'],
  ['EXITED', '已退出', 'muted'],
  ['FAILED', '失败', 'destructive'],
  // 工作负载日志五态
  ['PENDING', '等待', 'muted'],
  ['RUNNING', '执行中', 'info'],
  ['SUCCESS', '成功', 'success'],
  ['TIMEOUT', '超时', 'warning'],
  // 账单类型（BillingLedgerType）
  ['recharge', '入账', 'success'],
  ['charge', '消费', 'muted'],
  ['adjust', '调整', 'warning'],
  // 模型调用（BillingApiCall.status）
  ['started', '进行中/异常', 'warning'],
  ['completed', '完成', 'success'],
  ['aborted', '中断调用', 'warning'],
  ['failed', '失败', 'destructive'],
]

describe('状态徽标统一映射', () => {
  it.each(CONTRACT_STATUS_CASES)(
    'T-AUI-ST1: 契约枚举 %s → %s / %s',
    (status, label, variant) => {
      expect(statusBadgeProps(status)).toEqual({
        label,
        variant,
        tone: variant === 'default' ? 'primary' : variant,
      })
    },
  )

  it('T-AUI-ST1: 同一状态键恒返回同一 Badge 变体与文案', () => {
    expect(statusBadgeProps('INITIALIZING')).toEqual({
      label: '初始化中',
      variant: 'warning',
      tone: 'warning',
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
