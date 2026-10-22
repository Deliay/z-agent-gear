import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import GithubSetupProgressDialog from '../GithubSetupProgressDialog'
import type { CloudHostSetupOperationData } from '../../../graphql/types'

const mockUseQuery = vi.fn()
const mockNavigate = vi.fn()
const mockRetry = vi.fn()
const mockRefetch = vi.fn()
const mockRefetchHome = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockRetry, { loading: false }],
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('../../../stores/homeOverview', () => ({
  useHomeOverview: () => ({ refetch: mockRefetchHome }),
}))

function makeOperation(overrides: Partial<CloudHostSetupOperationData> = {}): CloudHostSetupOperationData {
  return {
    id: 'op-1',
    kind: 'GITHUB_SETUP',
    status: 'RUNNING',
    steps: [
      { key: 'workload', status: 'SUCCEEDED', detail: null },
      { key: 'gitSetup', status: 'RUNNING', detail: '正在拉取仓库' },
      { key: 'session', status: 'PENDING', detail: null },
    ],
    sessionId: null,
    error: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function mockOperation(operation: CloudHostSetupOperationData | null, options: { loading?: boolean } = {}) {
  mockUseQuery.mockReturnValue({
    data: operation ? { cloudHostSetupOperation: operation } : null,
    loading: Boolean(options.loading),
    error: undefined,
    refetch: mockRefetch,
  })
}

function renderDialog(operationId: string | null = 'op-1', onClose = vi.fn()) {
  return render(
    <GithubSetupProgressDialog open operationId={operationId} onClose={onClose} />,
  )
}

describe('GithubSetupProgressDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRetry.mockResolvedValue({ data: { retryCloudHostSetupOperation: makeOperation() } })
    mockRefetch.mockResolvedValue(undefined)
    mockRefetchHome.mockResolvedValue(undefined)
  })

  it('T-AW-G8 三步状态渲染且每 1.5s 轮询', () => {
    mockOperation(makeOperation())
    renderDialog()

    expect(screen.getByText('工作负载设置')).toBeInTheDocument()
    expect(screen.getByText('Git 项目设置')).toBeInTheDocument()
    expect(screen.getByText('会话创建')).toBeInTheDocument()

    expect(screen.getByText('成功')).toBeInTheDocument()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(screen.getByText('等待')).toBeInTheDocument()

    const options = mockUseQuery.mock.calls[0][1]
    expect(options.pollInterval).toBe(1500)
    expect(options.variables).toEqual({ id: 'op-1' })
  })

  it('T-AW-G8 轮询期间 loading 但已有数据时不卸载内容', () => {
    mockOperation(makeOperation())
    const { rerender } = renderDialog()

    mockOperation(makeOperation(), { loading: true })
    rerender(<GithubSetupProgressDialog open operationId="op-1" onClose={vi.fn()} />)

    expect(screen.getByText('工作负载设置')).toBeInTheDocument()
    expect(screen.queryByText('正在加载进度...')).not.toBeInTheDocument()
  })

  it('T-AW-G8 首次加载（无数据）展示加载态', () => {
    mockUseQuery.mockReturnValue({ data: null, loading: true, error: undefined, refetch: mockRefetch })
    renderDialog()

    expect(screen.getByText('正在加载进度...')).toBeInTheDocument()
  })

  it('T-AW-G9 失败展示 error 与 step detail，点击重试调用 mutation', async () => {
    mockOperation(
      makeOperation({
        status: 'FAILED',
        error: '等待工作负载执行超时',
        steps: [
          { key: 'workload', status: 'SUCCEEDED', detail: null },
          { key: 'gitSetup', status: 'FAILED', detail: '正在拉取仓库' },
          { key: 'session', status: 'PENDING', detail: null },
        ],
      }),
    )
    renderDialog()

    expect(screen.getByRole('alert')).toHaveTextContent('等待工作负载执行超时')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => {
      expect(mockRetry).toHaveBeenCalledWith({ variables: { id: 'op-1' } })
    })
    expect(mockRefetch).toHaveBeenCalled()
  })

  it('T-AW-G10 成功且有 sessionId 时 refetch 首页并跳转会话', async () => {
    mockOperation(
      makeOperation({
        status: 'SUCCEEDED',
        sessionId: 'session-9',
        steps: [
          { key: 'workload', status: 'SUCCEEDED', detail: null },
          { key: 'gitSetup', status: 'SUCCEEDED', detail: null },
          { key: 'session', status: 'SUCCEEDED', detail: null },
        ],
      }),
    )
    const onClose = vi.fn()
    renderDialog('op-1', onClose)

    await waitFor(() => {
      expect(mockRefetchHome).toHaveBeenCalled()
      expect(mockNavigate).toHaveBeenCalledWith('/sessions/session-9')
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('T-AW-G11 session 步骤失败时展示手动建会话提示且不跳转', () => {
    mockOperation(
      makeOperation({
        status: 'SUCCEEDED',
        sessionId: null,
        steps: [
          { key: 'workload', status: 'SUCCEEDED', detail: null },
          { key: 'gitSetup', status: 'SUCCEEDED', detail: null },
          { key: 'session', status: 'FAILED', detail: '创建会话失败' },
        ],
      }),
    )
    renderDialog()

    expect(screen.getByText('仓库已就绪，请手动创建会话')).toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('单步安装只展示工作负载一步', () => {
    mockOperation(
      makeOperation({
        kind: 'INSTALL_WORKLOAD',
        status: 'SUCCEEDED',
        steps: [{ key: 'workload', status: 'SUCCEEDED', detail: null }],
      }),
    )
    renderDialog()

    expect(screen.getByText('工作负载设置')).toBeInTheDocument()
    expect(screen.queryByText('Git 项目设置')).not.toBeInTheDocument()
    expect(screen.queryByText('会话创建')).not.toBeInTheDocument()
  })

  it('不展示 token 或命令细节', () => {
    mockOperation(
      makeOperation({
        steps: [
          { key: 'workload', status: 'SUCCEEDED', detail: null },
          { key: 'gitSetup', status: 'FAILED', detail: '正在拉取仓库' },
          { key: 'session', status: 'PENDING', detail: null },
        ],
        error: 'failed to issue github token',
      }),
    )
    renderDialog()

    expect(screen.queryByText(/ghp_/)).not.toBeInTheDocument()
    expect(screen.queryByText(/gh auth login/)).not.toBeInTheDocument()
  })

  it('operation 为空时提示无记录', () => {
    mockOperation(null)
    renderDialog()

    expect(screen.getByText('未找到操作记录')).toBeInTheDocument()
  })

  it('轮询查询使用 operationId，关闭时 onClose 被调用', () => {
    mockOperation(makeOperation())
    const onClose = vi.fn()
    renderDialog('op-1', onClose)

    const options = mockUseQuery.mock.calls[0][1]
    expect(options.skip).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalled()
  })
})
