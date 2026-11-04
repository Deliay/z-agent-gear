import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ForkCloudStorageDialog from '../ForkCloudStorageDialog'
import { CLOUD_STORAGE_BILLING_QUOTE } from '@/graphql/queries'
import type { CloudStorageBillingQuoteData, CloudStorageData } from '@/graphql/types'

const mockUseQuery = vi.fn()
const mockUseMutation = vi.fn()
const mockForkStorage = vi.fn()
const mockToastSuccess = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}))

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
  },
}))

function makeStorage(overrides: Partial<CloudStorageData> = {}): CloudStorageData {
  return {
    id: 'st-src',
    name: '源存储',
    sizeGi: 20,
    status: 'IDLE',
    usageBytes: 4096,
    usageUpdatedAt: '2026-11-02T10:00:00.000Z',
    hourlyCredits: 15,
    hourlyCreditsFull: 15,
    hourlyCreditsArchived: 7.5,
    createdBy: { id: 'u-1', name: 'alice' },
    createdAt: '2026-11-01T08:00:00.000Z',
    attachedCloudHostId: null,
    attachedCloudHostName: null,
    attachedAt: null,
    currentArchive: { id: 'ar-1', fileName: 'a.tar.gz2', status: 'SUCCEEDED' },
    currentRestore: null,
    forkedFromStorageId: null,
    archiveSpace: { capacityGi: 100, usedGi: null },
    failureReason: null,
    destroyedAt: null,
    ...overrides,
  }
}

function makeQuote(): CloudStorageBillingQuoteData {
  return {
    sizeGi: 20,
    full: { hourlyCredits: 15, tiers: [{ label: '前 10Gi', amountCredits: 5 }] },
    archived: { hourlyCredits: 7.5, tiers: [{ label: '前 10Gi', amountCredits: 2.5 }] },
    availableBalance: 100,
  }
}

describe('ForkCloudStorageDialog (T-WEB3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseMutation.mockReturnValue([mockForkStorage, { loading: false }])
    mockForkStorage.mockResolvedValue({
      data: { forkCloudStorage: makeStorage({ id: 'st-fork', name: '副本' }) },
    })
    mockUseQuery.mockImplementation((query: unknown) => {
      if (query === CLOUD_STORAGE_BILLING_QUOTE) {
        return { data: { cloudStorageBillingQuote: makeQuote() }, loading: false, error: null }
      }
      return { data: null, loading: false, error: null }
    })
  })

  it('容量与源一致且只读、展示全价报价与计费提示', () => {
    render(
      <ForkCloudStorageDialog
        open
        source={makeStorage()}
        onClose={vi.fn()}
        onForked={vi.fn()}
      />,
    )

    expect(screen.getByText('容量与源一致：20Gi（不可调整）')).toBeInTheDocument()
    expect(screen.getByText(/每小时费用：15 credits（创建成功即开始计费）/)).toBeInTheDocument()
    expect(mockUseQuery).toHaveBeenCalledWith(
      CLOUD_STORAGE_BILLING_QUOTE,
      expect.objectContaining({ variables: { sizeGi: 20 } }),
    )
    expect(screen.queryByLabelText('容量')).not.toBeInTheDocument()
  })

  it('名称校验（trim 1~64）并提交 fork，成功后回调刷新', async () => {
    const onClose = vi.fn()
    const onForked = vi.fn()
    render(
      <ForkCloudStorageDialog
        open
        source={makeStorage()}
        onClose={onClose}
        onForked={onForked}
      />,
    )

    expect(screen.getByRole('button', { name: '确认 fork' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('fork 云存储名称'), {
      target: { value: '  副本  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认 fork' }))

    await waitFor(() => {
      expect(mockForkStorage).toHaveBeenCalledWith({
        variables: { id: 'st-src', input: { name: '副本' } },
      })
    })
    expect(mockToastSuccess).toHaveBeenCalledWith('已创建 fork 云存储')
    expect(onForked).toHaveBeenCalledWith(expect.objectContaining({ id: 'st-fork' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('服务端错误文案映射（重名）且对话框保持打开', async () => {
    const onClose = vi.fn()
    mockForkStorage.mockRejectedValueOnce(new Error('storage name already exists'))
    render(
      <ForkCloudStorageDialog
        open
        source={makeStorage()}
        onClose={onClose}
        onForked={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('fork 云存储名称'), { target: { value: '副本' } })
    fireEvent.click(screen.getByRole('button', { name: '确认 fork' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '当前工作区已存在同名云存储',
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('T-WEB4 storage is not forkable 映射', async () => {
    mockForkStorage.mockRejectedValueOnce(new Error('storage is not forkable'))
    render(
      <ForkCloudStorageDialog
        open
        source={makeStorage()}
        onClose={vi.fn()}
        onForked={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('fork 云存储名称'), { target: { value: '副本' } })
    fireEvent.click(screen.getByRole('button', { name: '确认 fork' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '源存储没有可用归档，暂不可 fork',
    )
  })
})
