import { describe, expect, it } from 'vitest'
import { HARNESS_LABELS, harnessLabel } from '../harness-labels'

describe('harnessLabel', () => {
  it('已知类型映射为展示名', () => {
    expect(harnessLabel('opencode')).toBe('OpenCode')
    expect(harnessLabel('deepseek_harness')).toBe('DeepSeek Harness')
    expect(Object.keys(HARNESS_LABELS)).toHaveLength(8)
  })

  it('未知类型回退原值', () => {
    expect(harnessLabel('custom_harness')).toBe('custom_harness')
  })

  it('空值返回空串', () => {
    expect(harnessLabel(undefined)).toBe('')
    expect(harnessLabel(null)).toBe('')
    expect(harnessLabel('')).toBe('')
  })
})
