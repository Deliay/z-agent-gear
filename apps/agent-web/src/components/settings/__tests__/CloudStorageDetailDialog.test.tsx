import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import CloudStorageDetailDialog from '../CloudStorageDetailDialog'
import { CLOUD_STORAGE } from '@/graphql/queries'
import type { CloudStorageData } from '@/graphql/types'

const mockUseQuery = vi.fn()
const mockUseMutation = vi.fn()
const mockRefreshUsage = vi.fn()
const mockRetryArchive = vi.fn()
const mockDestroyStorage = vi.fn()
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
      const text = JSON.stringify(doc)
      if (text.includes('refreshCloudStorageUsage')) return [mockRefreshUsage, { loading: false }]
      if (text.includes('retryCloudStorageArchive')) return [mockRetryArchive, { loading: false }]
      return [mockDestroyStorage, { loading: false }]
    })
    mockRefreshUsage.mockResolvedValue({ data: { refreshCloudStorageUsage: makeStorage() } })
    mockRetryArchive.mockResolvedValue({ data: { retryCloudStorageArchive: makeStorage() } })
    mockDestroyStorage.mockResolvedValue({ data: { destroyCloudStorage: makeStorage() } })
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
})
