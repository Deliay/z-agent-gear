import { describe, it, expect } from 'vitest'
import { isRepoTemplateScanSupported } from '../repo-workflow'

describe('isRepoTemplateScanSupported', () => {
  it('版本 ≥2.18.0 为 true，低于/缺失/非法为 false', () => {
    expect(isRepoTemplateScanSupported('2.18.0')).toBe(true)
    expect(isRepoTemplateScanSupported('2.20.3')).toBe(true)
    expect(isRepoTemplateScanSupported('2.17.9')).toBe(false)
    expect(isRepoTemplateScanSupported('')).toBe(false)
    expect(isRepoTemplateScanSupported(null)).toBe(false)
    expect(isRepoTemplateScanSupported(undefined)).toBe(false)
  })
})
