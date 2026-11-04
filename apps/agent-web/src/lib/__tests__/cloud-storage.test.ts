import { describe, expect, it } from 'vitest'
import {
  RESTORE_DESTRUCTIVE_WARNING,
  canArchiveStorage,
  canDestroyCloudStorage,
  canForkStorage,
  canRestoreStorage,
  cloudStorageErrorMessage,
  cloudStorageStatusLabel,
  hasFailedRestore,
} from '../cloud-storage'
import type { CloudStorageData } from '../../graphql/types'

function storage(overrides: Partial<CloudStorageData> = {}): CloudStorageData {
  return {
    id: 'st-1',
    name: 'data',
    sizeGi: 10,
    status: 'IDLE',
    usageBytes: 0,
    usageUpdatedAt: null,
    hourlyCredits: 5,
    hourlyCreditsFull: 5,
    hourlyCreditsArchived: 2.5,
    createdBy: { id: 'u-1', name: 'alice' },
    createdAt: '2026-11-01T00:00:00.000Z',
    attachedCloudHostId: null,
    attachedCloudHostName: null,
    attachedAt: null,
    currentArchive: null,
    currentRestore: null,
    forkedFromStorageId: null,
    archiveSpace: { capacityGi: 100, usedGi: null },
    failureReason: null,
    destroyedAt: null,
    ...overrides,
  }
}

const succeededArchive = {
  id: 'ar-1',
  fileName: 'data-20261102-100000.tar.gz2',
  status: 'SUCCEEDED' as const,
}

describe('cloud storage status helpers (T-WEB2/T-WEB4)', () => {
  it('RESTORING 文案为「复原中」', () => {
    expect(cloudStorageStatusLabel('RESTORING')).toBe('复原中')
  })

  it('归档入口仅 IDLE', () => {
    expect(canArchiveStorage(storage({ status: 'IDLE' }))).toBe(true)
    expect(canArchiveStorage(storage({ status: 'ARCHIVED' }))).toBe(false)
    expect(canArchiveStorage(storage({ status: 'ATTACHED' }))).toBe(false)
  })

  it('复原入口：IDLE+SUCCEEDED，或 RESTORING+FAILED（重试）', () => {
    expect(
      canRestoreStorage(storage({ status: 'IDLE', currentArchive: succeededArchive })),
    ).toBe(true)
    expect(canRestoreStorage(storage({ status: 'IDLE', currentArchive: null }))).toBe(false)
    expect(
      canRestoreStorage(
        storage({
          status: 'RESTORING',
          currentRestore: { id: 'op-1', status: 'FAILED' },
        }),
      ),
    ).toBe(true)
    expect(
      canRestoreStorage(
        storage({
          status: 'RESTORING',
          currentRestore: { id: 'op-1', status: 'RUNNING' },
        }),
      ),
    ).toBe(false)
  })

  it('fork 入口：IDLE/ARCHIVED + SUCCEEDED 归档', () => {
    expect(canForkStorage(storage({ status: 'IDLE', currentArchive: succeededArchive }))).toBe(true)
    expect(
      canForkStorage(storage({ status: 'ARCHIVED', currentArchive: succeededArchive })),
    ).toBe(true)
    expect(canForkStorage(storage({ status: 'ATTACHED', currentArchive: succeededArchive }))).toBe(
      false,
    )
    expect(canForkStorage(storage({ status: 'IDLE', currentArchive: null }))).toBe(false)
  })

  it('复原失败可销毁（警示口径）', () => {
    const failed = storage({
      status: 'RESTORING',
      currentRestore: { id: 'op-1', status: 'FAILED' },
    })
    expect(hasFailedRestore(failed)).toBe(true)
    expect(canDestroyCloudStorage(failed)).toBe(true)
    expect(canDestroyCloudStorage(storage({ status: 'RESTORING', currentRestore: { id: 'op-1', status: 'RUNNING' } }))).toBe(false)
    expect(RESTORE_DESTRUCTIVE_WARNING).toContain('不可恢复')
  })

  it('T-WEB4 六条契约错误文案单一来源映射', () => {
    const expected: Record<string, string> = {
      'storage is not archivable': '仅待挂载状态可归档',
      'storage is not restorable': '当前状态不可复原到归档',
      'storage has no archive': '当前没有可用的归档',
      'storage is not forkable': '源存储没有可用归档，暂不可 fork',
      'storage is restoring': '复原仍在进行中，请稍后重试',
      'not allowed to restore storage': '没有复原该云存储的权限',
    }
    for (const [server, message] of Object.entries(expected)) {
      expect(cloudStorageErrorMessage(new Error(server))).toBe(message)
    }
    expect(cloudStorageErrorMessage(new Error('unknown'), 'fallback')).toBe('unknown')
    expect(cloudStorageErrorMessage(null, 'fallback')).toBe('fallback')
  })
})
