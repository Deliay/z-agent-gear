import { describe, it, expect } from 'vitest'
import { cloudHostStatusText } from '../cloud-host-status'

describe('cloudHostStatusText', () => {
  it('T-WEB7 STARTING 且 storageRestoring 时追加「正在恢复数据」', () => {
    expect(cloudHostStatusText({ status: 'STARTING', storageRestoring: true })).toBe(
      '启动中（正在恢复数据）',
    )
  })

  it('T-WEB7 非恢复中/非 STARTING 不追加提示', () => {
    expect(cloudHostStatusText({ status: 'STARTING', storageRestoring: false })).toBe('启动中')
    expect(cloudHostStatusText({ status: 'RUNNING', storageRestoring: true })).toBe('运行中')
  })
})
