import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import CloudStorageDetailDialog from '../CloudStorageDetailDialog'
import { CLOUD_STORAGE } from '@/graphql/queries'
import {
  ARCHIVE_CLOUD_STORAGE,
  FORK_CLOUD_STORAGE,
  RESTORE_CLOUD_STORAGE_TO_ARCHIVE,
} from '@/graphql/mutations'
import type { CloudStorageData } from '@/graphql/types'

const mockUseQuery = vi.fn()
const mockUseMutation = vi.fn()
const mockRefreshUsage = vi.fn()
const mockRetryArchive = vi.fn()
const mockDestroyStorage = vi.fn()
const mockArchiveStorage = vi.fn()
const mockRestoreStorage = vi.fn()
const mockForkStorage = vi.fn()
const mockRefetch = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../ForkCloudStorageDialog', () => ({
  default: ({ open, source }: { open: boolean; source: { id: string } | null }) =>
    open ? <div data-testid="fork-dialog" data-source-id={source?.id ?? ''} /> : null,
}))

function makeStorage(overrides: Partial<CloudStorageData> = {}): CloudStorageData {
  return {
    id: 'st-1',
    name: '设计资料',
    sizeGi: 20,
    status: 'ATTACHED',
    usageBytes: 1610612736,
    usageUpdatedAt: '2026-11-02T10:00:00.000Z',
    hourlyCredits: 15,
    hourlyCreditsFull: 15,
    hourlyCreditsArchived: 7.5,
    createdBy: { id: 'u-1', name: 'alice' },
    createdAt: '2026-11-01T08:00:00.000Z',
    attachedCloudHostId: 'host-1',
    attachedCloudHostName: '我的云电脑',
    attachedAt: '2026-11-02T09:00:00.000Z',
    currentArchive: {
      id: 'ar-1',
      fileName: 'my-host-20261102-100000.tar.gz2',
      status: 'SUCCEEDED',
      cloudHostId: 'host-1',
      cloudHostName: '我的云电脑',
      usageBytes: 2 * 1024 * 1024,
      startedAt: '2026-11-02T09:50:00.000Z',
      finishedAt: '2026-11-02T10:00:00.000Z',
      failureReason: null,
      sourcePvcReleased: false,
    },
    archiveSpace: { capacityGi: 100, usedGi: null },
    failureReason: null,
    destroyedAt: null,
    ...overrides,
  }
}

function mockDetail(storage: CloudStorageData) {
  mockUseQuery.mockImplementation((query: unknown) => {
    if (query === CLOUD_STORAGE) {
      return {
        data: { cloudStorage: storage },
        loading: false,
        error: null,
        refetch: mockRefetch,
      }
    }
    return { data: null, loading: false, error: null, refetch: mockRefetch }
  })
}

describe('CloudStorageDetailDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRefetch.mockResolvedValue(undefined)
    mockUseMutation.mockImplementation((doc: unknown) => {
      if (doc === ARCHIVE_CLOUD_STORAGE) return [mockArchiveStorage, { loading: false }]
      if (doc === RESTORE_CLOUD_STORAGE_TO_ARCHIVE)
        return [mockRestoreStorage, { loading: false }]
      if (doc === FORK_CLOUD_STORAGE) return [mockForkStorage, { loading: false }]
      const text = JSON.stringify(doc)
      if (text.includes('refreshCloudStorageUsage')) return [mockRefreshUsage, { loading: false }]
      if (text.includes('retryCloudStorageArchive')) return [mockRetryArchive, { loading: false }]
      return [mockDestroyStorage, { loading: false }]
    })
    mockRefreshUsage.mockResolvedValue({ data: { refreshCloudStorageUsage: makeStorage() } })
    mockRetryArchive.mockResolvedValue({ data: { retryCloudStorageArchive: makeStorage() } })
    mockDestroyStorage.mockResolvedValue({ data: { destroyCloudStorage: makeStorage() } })
    mockArchiveStorage.mockResolvedValue({ data: { archiveCloudStorage: makeStorage() } })
    mockRestoreStorage.mockResolvedValue({
      data: { restoreCloudStorageToArchive: makeStorage() },
    })
    mockForkStorage.mockResolvedValue({ data: { forkCloudStorage: makeStorage() } })
  })

  it('T-WEB7 展示基本信息/实际占用/当前归档，ATTACHED 可刷新用量', async () => {
    mockDetail(makeStorage())
    render(<CloudStorageDetailDialog open storageId="st-1" onClose={vi.fn()} />)

    const basicInfo = screen.getByTestId('cloud-storage-basic-info')
    expect(within(basicInfo).getByText('设计资料')).toBeInTheDocument()
    expect(within(basicInfo).getByText('20Gi')).toBeInTheDocument()
    expect(within(basicInfo).getByText('已挂载')).toBeInTheDocument()
    expect(within(basicInfo).getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('1.5 GiB')).toBeInTheDocument()
    expect(screen.getByText('my-host-20261102-100000.tar.gz2')).toBeInTheDocument()
    expect(screen.getByText('2.0 MiB')).toBeInTheDocument()
    expect(screen.getByText('归档成功')).toBeInTheDocument()
    expect(
      screen.getByText('源容量卷删除失败（数据已归档，再次挂载时自动清理）'),
    ).toBeInTheDocument()

    const refresh = screen.getByRole('button', { name: '刷新用量' })
    expect(refresh).toBeEnabled()
    fireEvent.click(refresh)
    await waitFor(() => {
      expect(mockRefreshUsage).toHaveBeenCalledWith({ variables: { id: 'st-1' } })
    })
    expect(screen.queryByRole('button', { name: '销毁云存储' })).not.toBeInTheDocument()
  })

  it('T-WEB6/T-WEB7 非 ATTACHED 刷新用量不可用；IDLE 可销毁并二次确认', async () => {
    mockDetail(makeStorage({ status: 'IDLE', attachedCloudHostName: null, currentArchive: null }))
    const onDestroyed = vi.fn()
    render(
      <CloudStorageDetailDialog
        open
        storageId="st-1"
        onClose={vi.fn()}
        onDestroyed={onDestroyed}
      />,
    )

    expect(screen.getByRole('button', { name: '刷新用量' })).toBeDisabled()
    expect(screen.getByText('暂无归档')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试归档' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '销毁云存储' }))
    expect(screen.getByText(/销毁云存储会删除全部数据与当前归档/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认销毁' }))

    await waitFor(() => {
      expect(mockDestroyStorage).toHaveBeenCalledWith({ variables: { id: 'st-1' } })
    })
    expect(onDestroyed).toHaveBeenCalled()
  })

  it('T-WEB6 ARCHIVING 且归档失败：展示警示、可重试归档、销毁需额外确认', async () => {
    mockDetail(
      makeStorage({
        status: 'ARCHIVING',
        attachedCloudHostName: null,
        currentArchive: {
          id: 'ar-failed',
          fileName: 'failed.tar.gz2',
          status: 'FAILED',
          usageBytes: 1024,
          startedAt: '2026-11-02T09:50:00.000Z',
          finishedAt: '2026-11-02T10:00:00.000Z',
          failureReason: '用量标记行缺失',
        },
      }),
    )
    render(<CloudStorageDetailDialog open storageId="st-1" onClose={vi.fn()} />)

    expect(screen.getByText('归档失败')).toBeInTheDocument()
    expect(screen.getByText('用量标记行缺失')).toBeInTheDocument()
    expect(screen.getByText(/数据尚未成功归档，销毁后将无法恢复/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试归档' }))
    await waitFor(() => {
      expect(mockRetryArchive).toHaveBeenCalledWith({ variables: { id: 'st-1' } })
    })

    fireEvent.click(screen.getByRole('button', { name: '销毁云存储' }))
    expect(screen.getByText(/数据尚未成功归档，销毁后将无法恢复。销毁云存储/)).toBeInTheDocument()
  })

  it('T-WEB2 IDLE+SUCCEEDED 展示归档/复原/fork 与确认文案；手动归档来源', async () => {
    mockDetail(
      makeStorage({
        status: 'IDLE',
        attachedCloudHostId: null,
        attachedCloudHostName: null,
        currentArchive: {
          id: 'ar-1',
          fileName: 'manual-20261102-100000.tar.gz2',
          status: 'SUCCEEDED',
          cloudHostId: null,
          cloudHostName: null,
          usageBytes: 1024,
        },
      }),
    )
    render(<CloudStorageDetailDialog open storageId="st-1" onClose={vi.fn()} />)

    expect(screen.getByText('手动归档')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '归档' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复原到归档' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'fork' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '归档' }))
    expect(screen.getByText(/归档后将释放数据卷并转为半价计费/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    await waitFor(() => {
      expect(mockArchiveStorage).toHaveBeenCalledWith({ variables: { id: 'st-1' } })
    })

    fireEvent.click(screen.getByRole('button', { name: '复原到归档' }))
    expect(screen.getByText(/当前内容将被丢弃并回滚到归档版本，不可恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认复原' }))
    await waitFor(() => {
      expect(mockRestoreStorage).toHaveBeenCalledWith({ variables: { id: 'st-1' } })
    })
  })

  it('T-WEB2 RESTORING 进行中无操作/无销毁；FAILED 展示重试与警示', () => {
    mockDetail(
      makeStorage({
        status: 'RESTORING',
        attachedCloudHostId: null,
        currentRestore: { id: 'op-1', status: 'RUNNING', startedAt: '2026-11-02T10:00:00.000Z' },
      }),
    )
    const { unmount } = render(
      <CloudStorageDetailDialog open storageId="st-1" onClose={vi.fn()} />,
    )
    expect(screen.getByText('复原中')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '归档' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复原到归档' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'fork' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '销毁云存储' })).not.toBeInTheDocument()
    unmount()

    mockDetail(
      makeStorage({
        status: 'RESTORING',
        attachedCloudHostId: null,
        currentRestore: {
          id: 'op-2',
          status: 'FAILED',
          failureReason: 'tar failed',
        },
      }),
    )
    render(<CloudStorageDetailDialog open storageId="st-1" onClose={vi.fn()} />)
    expect(screen.getByText('tar failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试复原' })).toBeInTheDocument()
    expect(screen.getByText(/复原失败，当前数据可能不完整/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '销毁云存储' })).toBeInTheDocument()
  })

  it('T-WEB4 复原错误文案映射（has no archive / is restoring / not allowed）', async () => {
    mockDetail(
      makeStorage({
        status: 'IDLE',
        attachedCloudHostId: null,
        currentArchive: {
          id: 'ar-1',
          fileName: 'a.tar.gz2',
          status: 'SUCCEEDED',
        },
      }),
    )
    render(<CloudStorageDetailDialog open storageId="st-1" onClose={vi.fn()} />)

    for (const [serverMessage, expected] of [
      ['storage has no archive', '当前没有可用的归档'],
      ['storage is restoring', '复原仍在进行中，请稍后重试'],
      ['not allowed to restore storage', '没有复原该云存储的权限'],
    ] as const) {
      mockRestoreStorage.mockRejectedValueOnce(new Error(serverMessage))
      fireEvent.click(screen.getByRole('button', { name: '复原到归档' }))
      fireEvent.click(screen.getByRole('button', { name: '确认复原' }))
      expect(await screen.findByText(expected)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
    }
  })
})
