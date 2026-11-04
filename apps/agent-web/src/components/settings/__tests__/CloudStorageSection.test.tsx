import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import CloudStorageSection from '../CloudStorageSection'
import { CLOUD_STORAGES } from '@/graphql/queries'
import {
  ARCHIVE_CLOUD_STORAGE,
  FORK_CLOUD_STORAGE,
  RESTORE_CLOUD_STORAGE_TO_ARCHIVE,
} from '@/graphql/mutations'
import type { CloudStorageData } from '@/graphql/types'

const mockUseQuery = vi.fn()
const mockUseMutation = vi.fn()
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

vi.mock('../NewCloudStorageDialog', () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-storage-dialog">新建云存储</div> : null,
}))

vi.mock('../CloudStorageDetailDialog', () => ({
  default: ({ open, storageId }: { open: boolean; storageId: string | null }) =>
    open ? <div data-testid="storage-detail-dialog" data-storage-id={storageId ?? ''} /> : null,
}))

vi.mock('../ForkCloudStorageDialog', () => ({
  default: ({ open, source }: { open: boolean; source: { id: string } | null }) =>
    open ? (
      <div data-testid="fork-storage-dialog" data-source-id={source?.id ?? ''}>
        fork 云存储
      </div>
    ) : null,
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
    mockUseMutation.mockImplementation((mutation: unknown) => {
      if (mutation === ARCHIVE_CLOUD_STORAGE) return [mockArchiveStorage, { loading: false }]
      if (mutation === RESTORE_CLOUD_STORAGE_TO_ARCHIVE)
        return [mockRestoreStorage, { loading: false }]
      if (mutation === FORK_CLOUD_STORAGE) return [mockForkStorage, { loading: false }]
      return [mockDestroyStorage, { loading: false }]
    })
    mockDestroyStorage.mockResolvedValue({ data: { destroyCloudStorage: makeStorage() } })
    mockArchiveStorage.mockResolvedValue({ data: { archiveCloudStorage: makeStorage() } })
    mockRestoreStorage.mockResolvedValue({ data: { restoreCloudStorageToArchive: makeStorage() } })
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

  it('T-WEB2 六态按钮矩阵：IDLE/ARCHIVED/ATTACHED/ARCHIVING/RESTORING', () => {
    mockStorages([
      makeStorage({
        id: 'st-idle-ok',
        name: '待挂载有归档',
        status: 'IDLE',
        currentArchive: { id: 'a1', fileName: 'a.tar.gz2', status: 'SUCCEEDED' },
      }),
      makeStorage({ id: 'st-idle', name: '待挂载无归档', status: 'IDLE' }),
      makeStorage({
        id: 'st-archived',
        name: '已归档',
        status: 'ARCHIVED',
        currentArchive: { id: 'a2', fileName: 'b.tar.gz2', status: 'SUCCEEDED' },
      }),
      makeStorage({ id: 'st-attached', name: '已挂载', status: 'ATTACHED' }),
      makeStorage({ id: 'st-archiving', name: '归档中', status: 'ARCHIVING' }),
      makeStorage({
        id: 'st-restoring',
        name: '复原中',
        status: 'RESTORING',
        currentArchive: { id: 'a3', fileName: 'c.tar.gz2', status: 'SUCCEEDED' },
        currentRestore: { id: 'op-1', status: 'RUNNING' },
      }),
      makeStorage({
        id: 'st-restore-failed',
        name: '复原失败',
        status: 'RESTORING',
        currentRestore: { id: 'op-2', status: 'FAILED' },
      }),
    ])

    render(<CloudStorageSection />)

    // IDLE + SUCCEEDED：归档 / 复原 / fork / 销毁
    expect(screen.getByRole('button', { name: '归档 待挂载有归档' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复原到归档 待挂载有归档' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'fork 待挂载有归档' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '销毁 待挂载有归档' })).toBeInTheDocument()

    // IDLE 无归档：仅归档/销毁
    expect(screen.getByRole('button', { name: '归档 待挂载无归档' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复原到归档 待挂载无归档' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'fork 待挂载无归档' })).not.toBeInTheDocument()

    // ARCHIVED：仅 fork/销毁
    expect(screen.queryByRole('button', { name: '归档 已归档' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复原到归档 已归档' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'fork 已归档' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '销毁 已归档' })).toBeInTheDocument()

    // ATTACHED / ARCHIVING / RESTORING 进行中：无三操作
    for (const name of ['已挂载', '归档中', '复原中']) {
      expect(screen.queryByRole('button', { name: `归档 ${name}` })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: `复原到归档 ${name}` })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: `fork ${name}` })).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: '销毁 复原中' })).not.toBeInTheDocument()

    // RESTORING+FAILED：重试复原 + 销毁
    expect(screen.getByRole('button', { name: '复原到归档 复原失败' })).toHaveTextContent('重试复原')
    expect(screen.getByRole('button', { name: '销毁 复原失败' })).toBeInTheDocument()
  })

  it('T-WEB2 归档确认文案与 mutation；复原确认 destructive 文案', async () => {
    mockStorages([
      makeStorage({
        status: 'IDLE',
        currentArchive: { id: 'a1', fileName: 'a.tar.gz2', status: 'SUCCEEDED' },
      }),
    ])
    render(<CloudStorageSection />)

    fireEvent.click(screen.getByRole('button', { name: '归档 设计资料' }))
    expect(screen.getByText(/归档后将释放数据卷并转为半价计费/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    await waitFor(() => {
      expect(mockArchiveStorage).toHaveBeenCalledWith({ variables: { id: 'st-1' } })
    })

    fireEvent.click(screen.getByRole('button', { name: '复原到归档 设计资料' }))
    expect(screen.getByText(/当前内容将被丢弃并回滚到归档版本，不可恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认复原' }))
    await waitFor(() => {
      expect(mockRestoreStorage).toHaveBeenCalledWith({ variables: { id: 'st-1' } })
    })
  })

  it('T-WEB4 新错误文案映射（not archivable / not allowed to restore）', async () => {
    mockStorages([
      makeStorage({
        status: 'IDLE',
        currentArchive: { id: 'a1', fileName: 'a.tar.gz2', status: 'SUCCEEDED' },
      }),
    ])
    mockArchiveStorage.mockRejectedValueOnce(new Error('storage is not archivable'))
    render(<CloudStorageSection />)

    fireEvent.click(screen.getByRole('button', { name: '归档 设计资料' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    await waitFor(() => {
      expect(mockArchiveStorage).toHaveBeenCalledWith({ variables: { id: 'st-1' } })
    })
    expect(await screen.findByText('仅待挂载状态可归档')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    mockRestoreStorage.mockRejectedValueOnce(new Error('not allowed to restore storage'))
    fireEvent.click(screen.getByRole('button', { name: '复原到归档 设计资料' }))
    fireEvent.click(screen.getByRole('button', { name: '确认复原' }))
    expect(await screen.findByText('没有复原该云存储的权限')).toBeInTheDocument()
  })
})
