import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import NewCloudStorageDialog from '../NewCloudStorageDialog'
import { CLOUD_STORAGE_BILLING_QUOTE } from '@/graphql/queries'
import type { CloudStorageBillingQuoteData, CloudStorageData } from '@/graphql/types'

const mockUseQuery = vi.fn()
const mockUseMutation = vi.fn()
const mockCreateStorage = vi.fn()
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

function makeQuote(sizeGi: number): CloudStorageBillingQuoteData {
  const hourly = sizeGi <= 10 ? 5 : 15
  return {
    sizeGi,
    full: {
      hourlyCredits: hourly,
      tiers: [
        { label: '1-10Gi 固定', amountCredits: 5 },
        ...(sizeGi > 10 ? [{ label: '10-25Gi 每 Gi', amountCredits: 10 }] : []),
      ],
    },
    archived: {
      hourlyCredits: hourly / 2,
      tiers: [
        { label: '1-10Gi 固定（半价）', amountCredits: 2.5 },
        ...(sizeGi > 10 ? [{ label: '10-25Gi 每 Gi（半价）', amountCredits: 5 }] : []),
      ],
    },
    availableBalance: 100,
  }
}

function makeStorage(overrides: Partial<CloudStorageData> = {}): CloudStorageData {
  return {
    id: 'st-new',
    name: '新存储',
    sizeGi: 20,
    status: 'IDLE',
    usageBytes: 0,
    usageUpdatedAt: null,
    hourlyCredits: 15,
    hourlyCreditsFull: 15,
    hourlyCreditsArchived: 7.5,
    createdBy: { id: 'u-1', name: 'alice' },
    createdAt: '2026-11-02T10:00:00.000Z',
    attachedCloudHostId: null,
    attachedCloudHostName: null,
    attachedAt: null,
    currentArchive: null,
    archiveSpace: { capacityGi: 100, usedGi: null },
    failureReason: null,
    destroyedAt: null,
    ...overrides,
  }
}

function submitButton() {
  return screen.getByRole('button', { name: /创建云存储|创建中/ })
}

describe('NewCloudStorageDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseMutation.mockReturnValue([mockCreateStorage, { loading: false }])
    mockCreateStorage.mockResolvedValue({ data: { createCloudStorage: makeStorage() } })
    mockUseQuery.mockImplementation(
      (query: unknown, options?: { variables?: { sizeGi?: number } }) => {
        if (query === CLOUD_STORAGE_BILLING_QUOTE) {
          const sizeGi = options?.variables?.sizeGi ?? 10
          return {
            data: { cloudStorageBillingQuote: makeQuote(sizeGi) },
            loading: false,
            error: null,
          }
        }
        return { data: null, loading: false, error: null }
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('T-WEB2 默认容量 10Gi，展示全价/归档半价/分档与计费提示', () => {
    render(<NewCloudStorageDialog open onClose={vi.fn()} />)

    expect(screen.getByLabelText('容量（Gi）')).toHaveValue(10)
    expect(screen.getByText('全价：5 credits/小时')).toBeInTheDocument()
    expect(screen.getByText('已归档半价：2.5 credits/小时')).toBeInTheDocument()
    expect(screen.getByText('1-10Gi 固定：5 credits/小时')).toBeInTheDocument()
    expect(screen.getByText('创建成功即开始计费')).toBeInTheDocument()
  })

  it('T-WEB2 名称/容量校验：空名称、越界容量禁用提交', () => {
    render(<NewCloudStorageDialog open onClose={vi.fn()} />)

    expect(screen.getByText('请输入云存储名称')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新存储' } })
    fireEvent.change(screen.getByLabelText('容量（Gi）'), { target: { value: '31' } })
    expect(screen.getByText('容量必须在 1~30Gi 之间')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('容量（Gi）'), { target: { value: '0' } })
    expect(screen.getByText('容量必须在 1~30Gi 之间')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })

  it('T-WEB2 容量变化后 300ms 防抖再请求报价', () => {
    vi.useFakeTimers()
    render(<NewCloudStorageDialog open onClose={vi.fn()} />)

    const sizeCalls = () =>
      mockUseQuery.mock.calls
        .filter((call) => call[0] === CLOUD_STORAGE_BILLING_QUOTE)
        .map((call) => call[1]?.variables?.sizeGi)
    expect(sizeCalls()).toContain(10)

    fireEvent.change(screen.getByLabelText('容量（Gi）'), { target: { value: '20' } })
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(sizeCalls()).not.toContain(20)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(sizeCalls()).toContain(20)
    expect(screen.getByText('全价：15 credits/小时')).toBeInTheDocument()
    expect(screen.getByText('已归档半价：7.5 credits/小时')).toBeInTheDocument()
  })

  it('T-WEB2 提交中禁用重复提交，成功后回调并关闭', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined
    mockCreateStorage.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )
    const onCreated = vi.fn()
    const onClose = vi.fn()

    render(<NewCloudStorageDialog open onClose={onClose} onCreated={onCreated} />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  新存储  ' } })
    fireEvent.change(screen.getByLabelText('容量（Gi）'), { target: { value: '20' } })
    fireEvent.click(submitButton())

    expect(await screen.findByRole('button', { name: '创建中...' })).toBeDisabled()
    expect(mockCreateStorage).toHaveBeenCalledWith({
      variables: { input: { name: '新存储', sizeGi: 20 } },
    })

    await act(async () => {
      resolveCreate?.({ data: { createCloudStorage: makeStorage() } })
    })
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'st-new' }))
    })
    expect(onClose).toHaveBeenCalled()
    expect(mockToastSuccess).toHaveBeenCalledWith('云存储创建成功')
  })

  it('T-WEB2 服务端错误文案映射（重名/容量/余额）', async () => {
    mockCreateStorage.mockRejectedValueOnce(new Error('storage name already exists'))

    const { rerender } = render(<NewCloudStorageDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新存储' } })
    fireEvent.click(submitButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('当前工作区已存在同名云存储')

    mockCreateStorage.mockRejectedValueOnce(new Error('insufficient balance'))
    rerender(<NewCloudStorageDialog open={false} onClose={vi.fn()} />)
    rerender(<NewCloudStorageDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新存储' } })
    fireEvent.click(submitButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '账户余额不足，请联系管理员充值后重试',
    )
  })
})
