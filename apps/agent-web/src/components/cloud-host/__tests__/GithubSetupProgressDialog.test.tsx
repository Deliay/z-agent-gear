import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import GithubSetupProgressDialog from '../GithubSetupProgressDialog'
import { CLOUD_HOST } from '../../../graphql/queries'
import type { CloudHostData, CloudHostSetupOperationData } from '../../../graphql/types'

const mockUseQuery = vi.fn()
const mockNavigate = vi.fn()
const mockRetry = vi.fn()
const mockRefetch = vi.fn()
const mockRefetchHome = vi.fn()
const mockRefetchQueries = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockRetry, { loading: false }],
  useApolloClient: () => ({ refetchQueries: mockRefetchQueries }),
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
    mockRefetchQueries.mockResolvedValue(undefined)
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
    expect(mockRefetchQueries).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.any(Array) }),
    )
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

function makeHost(overrides: Partial<CloudHostData> = {}): CloudHostData {
  return {
    id: 'cloud-1',
    name: '云电脑 A',
    controllerId: 'ctrl-cloud',
    status: 'STARTING',
    harnessTypes: ['OPENCODE'],
    defaultSessionId: null,
    activeSessionCount: 0,
    failureReason: null,
    deletedAt: null,
    ...overrides,
  }
}

function mockHostAndOperation(
  host: CloudHostData,
  operation: CloudHostSetupOperationData | null,
) {
  mockUseQuery.mockImplementation((query: unknown) => {
    if (query === CLOUD_HOST) {
      return { data: { cloudHost: host }, loading: false, error: undefined }
    }
    return {
      data: operation ? { cloudHostSetupOperation: operation } : null,
      loading: false,
      error: undefined,
      refetch: mockRefetch,
    }
  })
}

describe('GithubSetupProgressDialog 新建云电脑编排（四阶段）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRetry.mockResolvedValue({ data: { retryCloudHostSetupOperation: makeOperation() } })
    mockRefetch.mockResolvedValue(undefined)
    mockRefetchHome.mockResolvedValue(undefined)
    mockRefetchQueries.mockResolvedValue(undefined)
  })

  it('传入 hostId 时展示「启动云电脑」前置阶段与 1.5s 轮询', () => {
    mockHostAndOperation(makeHost({ status: 'STARTING' }), null)
    render(
      <GithubSetupProgressDialog open hostId="cloud-1" operationId={null} onClose={vi.fn()} />,
    )

    expect(screen.getByText('启动云电脑')).toBeInTheDocument()
    expect(screen.getByText('工作负载设置')).toBeInTheDocument()
    expect(screen.getByText('Git 项目设置')).toBeInTheDocument()
    expect(screen.getByText('会话创建')).toBeInTheDocument()
    expect(screen.getByText('正在启动云电脑...')).toBeInTheDocument()

    const hostCall = mockUseQuery.mock.calls.find((call) => call[0] === CLOUD_HOST)
    expect(hostCall?.[1]).toEqual(
      expect.objectContaining({ variables: { id: 'cloud-1' }, pollInterval: 1500, skip: false }),
    )
  })

  it('云电脑 RUNNING 时只回调一次 onHostRunning', () => {
    const onHostRunning = vi.fn()
    mockHostAndOperation(makeHost({ status: 'RUNNING' }), null)
    const { rerender } = render(
      <GithubSetupProgressDialog
        open
        hostId="cloud-1"
        operationId={null}
        onHostRunning={onHostRunning}
        onClose={vi.fn()}
      />,
    )

    rerender(
      <GithubSetupProgressDialog
        open
        hostId="cloud-1"
        operationId={null}
        onHostRunning={onHostRunning}
        onClose={vi.fn()}
      />,
    )

    expect(onHostRunning).toHaveBeenCalledTimes(1)
    expect(onHostRunning).toHaveBeenCalledWith(expect.objectContaining({ id: 'cloud-1' }))
  })

  it('启动失败停在「启动云电脑」：展示失败原因与「重新创建」', () => {
    const onStartupFailed = vi.fn()
    const onClose = vi.fn()
    mockHostAndOperation(
      makeHost({ status: 'FAILED', failureReason: '容器启动超时' }),
      null,
    )
    render(
      <GithubSetupProgressDialog
        open
        hostId="cloud-1"
        operationId={null}
        onStartupFailed={onStartupFailed}
        onClose={onClose}
      />,
    )

    expect(screen.getByText('容器启动超时')).toBeInTheDocument()
    expect(screen.getByText('云电脑启动失败，请删除后重新创建')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重新创建' }))
    expect(onStartupFailed).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('项目准备请求失败（无 operation）时展示错误并可原地重试', () => {
    const onRetrySetup = vi.fn()
    mockHostAndOperation(makeHost({ status: 'RUNNING' }), null)
    render(
      <GithubSetupProgressDialog
        open
        hostId="cloud-1"
        operationId={null}
        setupError="repository is not authorized"
        onRetrySetup={onRetrySetup}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('repository is not authorized')
    fireEvent.click(screen.getByRole('button', { name: '重新设置' }))
    expect(onRetrySetup).toHaveBeenCalledTimes(1)
  })
})
