import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import CloudStorageSection from '../CloudStorageSection'
import { CLOUD_STORAGES } from '@/graphql/queries'
import type { CloudStorageData } from '@/graphql/types'

const mockUseQuery = vi.fn()
const mockUseMutation = vi.fn()
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

vi.mock('../NewCloudStorageDialog', () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-storage-dialog">新建云存储</div> : null,
}))

vi.mock('../CloudStorageDetailDialog', () => ({
  default: ({ open, storageId }: { open: boolean; storageId: string | null }) =>
    open ? <div data-testid="storage-detail-dialog" data-storage-id={storageId ?? ''} /> : null,
}))

function makeStorage(overrides: Partial<CloudStorageData> = {}): CloudStorageData {
  return {
    id: 'st-1',
    name: '设计资料',
    sizeGi: 20,
    status: 'IDLE',
    usageBytes: 1610612736,
    usageUpdatedAt: '2026-11-02T10:00:00.000Z',
    hourlyCredits: 15,
    hourlyCreditsFull: 15,
    hourlyCreditsArchived: 7.5,
    createdBy: { id: 'u-1', name: 'alice' },
    createdAt: '2026-11-01T08:00:00.000Z',
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

function mockStorages(main: CloudStorageData[], destroyed: CloudStorageData[] = []) {
  mockUseQuery.mockImplementation((query: unknown, options?: { variables?: { includeDestroyed?: boolean } }) => {
    if (query === CLOUD_STORAGES) {
      return {
        data: {
          cloudStorages: options?.variables?.includeDestroyed ? destroyed : main,
        },
        loading: false,
        error: null,
        refetch: mockRefetch,
      }
    }
    return { data: null, loading: false, error: null, refetch: mockRefetch }
  })
}

describe('CloudStorageSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseMutation.mockReturnValue([mockDestroyStorage, { loading: false }])
    mockDestroyStorage.mockResolvedValue({ data: { destroyCloudStorage: makeStorage() } })
    mockRefetch.mockResolvedValue({ data: { cloudStorages: [] } })
  })

  it('T-WEB1 主列表展示名称/容量/状态/占用/费用/创建人/创建时间/挂载云电脑', () => {
    mockStorages([
      makeStorage({
        status: 'ATTACHED',
        attachedCloudHostId: 'host-1',
        attachedCloudHostName: '我的云电脑',
        usageBytes: 2 * 1024 * 1024,
      }),
    ])

    render(<CloudStorageSection />)

    expect(screen.getByText('设计资料')).toBeInTheDocument()
    expect(screen.getByText('已挂载')).toBeInTheDocument()
    expect(screen.getByText('20Gi')).toBeInTheDocument()
    expect(screen.getByText('2.0 MiB')).toBeInTheDocument()
    expect(screen.getByText('15 credits')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('我的云电脑')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看 设计资料 详情' })).toBeInTheDocument()
  })

  it('T-WEB1 已销毁折叠区默认折叠、展开后无操作入口（含创建失败）', () => {
    mockStorages(
      [],
      [
        makeStorage({
          id: 'st-dead',
          name: '旧存储',
          status: 'DESTROYED',
          destroyedAt: '2026-11-02T11:00:00.000Z',
        }),
        makeStorage({
          id: 'st-failed',
          name: '失败存储',
          status: 'CREATE_FAILED',
          failureReason: 'pvc create failed',
          destroyedAt: '2026-11-02T12:00:00.000Z',
        }),
      ],
    )

    render(<CloudStorageSection />)

    expect(screen.queryByText('旧存储')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '已销毁' }))

    const region = screen.getByRole('region', { name: '已销毁的云存储' })
    expect(within(region).getByText('旧存储')).toBeInTheDocument()
    expect(within(region).getByText('失败存储')).toBeInTheDocument()
    expect(within(region).getByText('已销毁')).toBeInTheDocument()
    expect(within(region).getByText('创建失败')).toBeInTheDocument()
    expect(within(region).queryByRole('button')).not.toBeInTheDocument()
  })

  it('T-WEB1 空态引导新建云存储', () => {
    mockStorages([])

    render(<CloudStorageSection />)

    expect(screen.getByText('暂无云存储')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '新建云存储' })[0])
    expect(screen.getByTestId('new-storage-dialog')).toBeInTheDocument()
  })

  it('T-WEB1 列表查询仅使用 onlyAttachable/includeDestroyed，工作区由服务端上下文隔离', () => {
    mockStorages([])

    render(<CloudStorageSection />)

    const mainCall = mockUseQuery.mock.calls.find(
      (call) => call[0] === CLOUD_STORAGES && call[1]?.variables?.includeDestroyed === false,
    )
    expect(mainCall?.[1]?.variables).toEqual({
      onlyAttachable: false,
      includeDestroyed: false,
    })
    expect(mainCall?.[1]?.variables).not.toHaveProperty('workspaceId')
  })

  it('T-WEB6 ATTACHED / ARCHIVING 进行中无销毁入口；归档失败时展示额外警示', async () => {
    mockStorages([
      makeStorage({ id: 'st-attached', name: '已挂载存储', status: 'ATTACHED' }),
      makeStorage({
        id: 'st-running',
        name: '归档中存储',
        status: 'ARCHIVING',
        currentArchive: {
          id: 'ar-1',
          fileName: 'a.tar.gz2',
          status: 'RUNNING',
        },
      }),
      makeStorage({
        id: 'st-failed-archive',
        name: '归档失败存储',
        status: 'ARCHIVING',
        currentArchive: {
          id: 'ar-2',
          fileName: 'b.tar.gz2',
          status: 'FAILED',
          failureReason: '用量标记行缺失',
        },
      }),
    ])

    render(<CloudStorageSection />)

    expect(screen.queryByRole('button', { name: '销毁 已挂载存储' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '销毁 归档中存储' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '销毁 归档失败存储' }))
    expect(screen.getByText(/数据尚未成功归档/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '确认销毁' }))
    await waitFor(() => {
      expect(mockDestroyStorage).toHaveBeenCalledWith({ variables: { id: 'st-failed-archive' } })
    })
  })

  it('点击详情打开详情对话框并传入存储 id', () => {
    mockStorages([makeStorage()])

    render(<CloudStorageSection />)

    fireEvent.click(screen.getByRole('button', { name: '查看 设计资料 详情' }))
    expect(screen.getByTestId('storage-detail-dialog')).toHaveAttribute('data-storage-id', 'st-1')
  })
})
