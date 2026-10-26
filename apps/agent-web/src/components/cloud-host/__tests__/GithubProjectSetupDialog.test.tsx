import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import GithubProjectSetupDialog from '../GithubProjectSetupDialog'
import { GET_GITHUB_ACCOUNTS, CLOUD_HOST_WORKLOADS } from '../../../graphql/queries'
import type { CloudHostData, CloudHostWorkloadItemData, GitHubAccountData } from '../../../graphql/types'

const mockUseQuery = vi.fn()
const mockNavigate = vi.fn()
const mockSetupGithubProject = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockSetupGithubProject],
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('../GithubSetupProgressDialog', () => ({
  default: ({ open, operationId }: { open: boolean; operationId: string | null }) =>
    open ? <div data-testid="github-progress-dialog" data-operation-id={operationId ?? ''} /> : null,
}))

const cloudHost = {
  id: 'cloud-1',
  name: '云电脑 A',
  status: 'RUNNING' as const,
  deletedAt: null,
  defaultWorkspace: '/home/worker/workspace',
  hasDefaultWorkspace: true,
}

const accounts: GitHubAccountData[] = [
  {
    id: 'acc-1',
    githubUserId: 1,
    githubLogin: 'alice',
    createdAt: '',
    installations: [
      {
        id: 'inst-1',
        installationId: 10,
        managementUrl: '',
        createdAt: '',
        repos: [
          {
            id: 'repo-1',
            repoId: 1,
            repoName: 'repo-a',
            fullName: 'alice/repo-a',
            private: false,
            permissions: { read: true, write: true },
          },
          {
            id: 'repo-2',
            repoId: 2,
            repoName: 'repo-b',
            fullName: 'alice/repo-b',
            private: false,
            permissions: { read: true, write: true },
          },
        ],
      },
      {
        id: 'inst-2',
        installationId: 11,
        managementUrl: '',
        createdAt: '',
        repos: [
          {
            id: 'repo-3',
            repoId: 3,
            repoName: 'repo-c',
            fullName: 'alice/repo-c',
            private: true,
            permissions: { read: true, write: true },
          },
          {
            id: 'repo-2-dup',
            repoId: 2,
            repoName: 'repo-b',
            fullName: 'alice/repo-b',
            private: false,
            permissions: { read: true, write: true },
          },
        ],
      },
    ],
  },
  {
    id: 'acc-2',
    githubUserId: 2,
    githubLogin: 'bob',
    createdAt: '',
    installations: [],
  },
]

const workloads: CloudHostWorkloadItemData[] = [
  {
    workloadId: 'wl-github',
    name: 'Github',
    paramSchema: [],
    dependsOnWorkloadIds: [],
    isPreset: true,
    installed: false,
  },
  {
    workloadId: 'wl-node',
    name: 'Node.js',
    paramSchema: [],
    dependsOnWorkloadIds: [],
    isPreset: false,
    installed: false,
  },
]

function mockQueries(
  options: { accounts?: GitHubAccountData[]; workloads?: CloudHostWorkloadItemData[]; accountsLoading?: boolean } = {},
) {
  mockUseQuery.mockImplementation((query: unknown) => {
    if (query === GET_GITHUB_ACCOUNTS) {
      return {
        data: options.accountsLoading ? null : { githubAccounts: options.accounts ?? accounts },
        loading: Boolean(options.accountsLoading),
      }
    }
    if (query === CLOUD_HOST_WORKLOADS) {
      return { data: { cloudHostWorkloads: options.workloads ?? workloads }, loading: false }
    }
    return { data: null, loading: false }
  })
}

function renderDialog(overrides: Partial<Pick<CloudHostData, 'name' | 'status' | 'deletedAt' | 'defaultWorkspace' | 'hasDefaultWorkspace'>> = {}) {
  return render(
    <GithubProjectSetupDialog
      open
      controllerId="ctrl-1"
      cloudHost={{ ...cloudHost, ...overrides }}
      onClose={vi.fn()}
    />,
  )
}

async function selectRepo(fullName = 'alice/repo-a') {
  await waitFor(() => expect(screen.getByLabelText('Github 账号')).toHaveValue('acc-1'))
  fireEvent.change(screen.getByLabelText('仓库'), { target: { value: fullName } })
}

const submitButton = () => screen.getByRole('button', { name: '开始设置' })

describe('GithubProjectSetupDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQueries()
    mockSetupGithubProject.mockResolvedValue({
      data: {
        setupCloudHostGithubProject: {
          id: 'op-1',
          kind: 'GITHUB_SETUP',
          status: 'RUNNING',
          steps: [],
          sessionId: null,
          error: null,
          createdAt: '',
          updatedAt: '',
        },
      },
    })
  })

  it('T-AW-G3 未绑定账号时展示引导并禁用确认', async () => {
    mockQueries({ accounts: [] })
    renderDialog()

    expect(await screen.findByText('尚未绑定 Github 帐号')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '前往设置页绑定 Github 帐号' }))
    expect(mockNavigate).toHaveBeenCalledWith('/settings#github-section')
  })

  it('T-AW-G4 仓库按账号过滤、跨 installation 去重，空列表提示', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByLabelText('Github 账号')).toHaveValue('acc-1'))

    expect(screen.getAllByRole('option', { name: 'alice/repo-a' })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: 'alice/repo-b' })).toHaveLength(1)
    expect(screen.getAllByRole('option', { name: 'alice/repo-c' })).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Github 账号'), { target: { value: 'acc-2' } })
    expect(screen.getByText('该账号暂无授权仓库，请前往设置页授权')).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'alice/repo-a' })).not.toBeInTheDocument()
  })

  it('T-AW-G5 Github 预制工作负载默认选中且不可取消', async () => {
    renderDialog()

    const github = await screen.findByLabelText('Github')
    expect(github).toBeChecked()
    expect(github).toBeDisabled()
    expect(screen.getByLabelText('Node.js')).not.toBeChecked()
  })

  it('T-AW-G6 默认前缀等于 cloudHost.defaultWorkspace 且可编辑', async () => {
    renderDialog()

    const input = screen.getByLabelText('前缀地址')
    await waitFor(() => expect(input).toHaveValue('/home/worker/workspace'))

    fireEvent.change(input, { target: { value: '/home/worker/workspace/custom' } })
    expect(input).toHaveValue('/home/worker/workspace/custom')
  })

  it('无默认工作区时预填 ~/workspace，且可直接提交', async () => {
    renderDialog({ hasDefaultWorkspace: false })

    const input = screen.getByLabelText('前缀地址')
    await waitFor(() => expect(input).toHaveValue('~/workspace'))
    expect(input).toHaveAttribute('placeholder', '例如：~/workspace')

    await selectRepo()
    expect(screen.queryByText('请输入前缀地址')).not.toBeInTheDocument()
    expect(screen.getByText('最终 clone 地址：/home/worker/workspace/alice/repo-a')).toBeInTheDocument()
    expect(submitButton()).not.toBeDisabled()
  })

  it('有默认工作区时仍预填 cloudHost.defaultWorkspace', async () => {
    renderDialog({ hasDefaultWorkspace: true })

    await waitFor(() => expect(screen.getByLabelText('前缀地址')).toHaveValue('/home/worker/workspace'))
  })

  it('T-WEB-G1: 选择仓库后展示最终 clone 地址', async () => {
    renderDialog()
    await selectRepo('alice/repo-a')

    expect(screen.getByText('最终 clone 地址：/home/worker/workspace/alice/repo-a')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('前缀地址'), { target: { value: '/work/' } })
    expect(screen.getByText('最终 clone 地址：/work/alice/repo-a')).toBeInTheDocument()
  })

  it('T-AW-G7 / T-WEB-G2 空/相对路径/含 .. 禁用确认并提示', async () => {
    renderDialog()
    await selectRepo()
    const input = screen.getByLabelText('前缀地址')

    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('请输入前缀地址')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()

    fireEvent.change(input, { target: { value: 'workspace/repo' } })
    expect(screen.getByText('前缀地址必须以 / 或 ~ 开头')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()

    fireEvent.change(input, { target: { value: '/home/worker/../etc' } })
    expect(screen.getByText('前缀地址不能包含 ..')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()

    fireEvent.change(input, { target: { value: '/home/worker\\workspace' } })
    expect(screen.getByText('前缀地址包含非法字符')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()

    fireEvent.change(input, { target: { value: 'root\\workspace' } })
    expect(screen.getByText('前缀地址包含非法字符')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()

    fireEvent.change(input, { target: { value: '/workspace/repo/' } })
    expect(submitButton()).not.toBeDisabled()
  })

  it('主机非 RUNNING 时禁用确认', async () => {
    renderDialog({ status: 'STOPPED' })
    await waitFor(() => expect(screen.getByLabelText('Github 账号')).toHaveValue('acc-1'))
    fireEvent.change(screen.getByLabelText('仓库'), { target: { value: 'alice/repo-a' } })

    expect(screen.getByText('云电脑未运行，无法设置 Git 项目')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })

  it('T-WEB-G3 提交的是归一后的前缀（非最终目录）', async () => {
    renderDialog()
    await selectRepo()
    fireEvent.change(screen.getByLabelText('前缀地址'), { target: { value: '/home/worker//workspace/' } })
    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(mockSetupGithubProject).toHaveBeenCalledWith({
        variables: {
          input: {
            controllerId: 'ctrl-1',
            accountId: 'acc-1',
            repoFullName: 'alice/repo-a',
            targetPath: '/home/worker/workspace',
            workloadIds: ['wl-github'],
          },
        },
      })
    })
    const dialog = await screen.findByTestId('github-progress-dialog')
    expect(dialog).toHaveAttribute('data-operation-id', 'op-1')
  })

  it('T-CH-WS1 前端将 ~/workspace 展开为 /home/worker/workspace 后提交', async () => {
    renderDialog({ hasDefaultWorkspace: false })
    await selectRepo()
    fireEvent.change(screen.getByLabelText('前缀地址'), { target: { value: '~/workspace' } })
    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(mockSetupGithubProject).toHaveBeenCalledWith({
        variables: {
          input: {
            controllerId: 'ctrl-1',
            accountId: 'acc-1',
            repoFullName: 'alice/repo-a',
            targetPath: '/home/worker/workspace',
            workloadIds: ['wl-github'],
          },
        },
      })
    })
  })

  it('服务端错误原样展示', async () => {
    mockSetupGithubProject.mockRejectedValueOnce(new Error('repository is not authorized'))
    renderDialog()
    await selectRepo()
    fireEvent.click(submitButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('repository is not authorized')
  })

  it('T-AW-G14 移动端弹窗不横向溢出', async () => {
    renderDialog()
    await screen.findByLabelText('Github 账号')

    const dialog = screen.getByRole('dialog')
    expect(Math.max(0, dialog.scrollWidth - dialog.clientWidth)).toBeLessThanOrEqual(1)
    expect(dialog.querySelector('.min-w-0')).not.toBeNull()
  })
})
