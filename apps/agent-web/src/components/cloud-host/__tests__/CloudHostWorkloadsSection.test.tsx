import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import CloudHostWorkloadsSection from '../CloudHostWorkloadsSection'
import type { CloudHostData, CloudHostWorkloadItemData } from '../../../graphql/types'

const mockUseQuery = vi.fn()
const mockInstallWorkload = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockInstallWorkload],
}))

vi.mock('../GithubSetupProgressDialog', () => ({
  default: ({ open, operationId }: { open: boolean; operationId: string | null }) =>
    open ? <div data-testid="setup-progress-dialog" data-operation-id={operationId ?? ''} /> : null,
}))

const cloudHost: Pick<CloudHostData, 'id' | 'name' | 'status' | 'deletedAt' | 'workloadInstalling'> = {
  id: 'cloud-1',
  name: '云电脑 A',
  status: 'RUNNING',
  deletedAt: null,
  workloadInstalling: null,
}

const workloads: CloudHostWorkloadItemData[] = [
  {
    workloadId: 'wl-github',
    name: 'Github',
    paramSchema: [],
    dependsOnWorkloadIds: [],
    isPreset: true,
    installed: true,
    installedAt: '2026-01-01T00:00:00Z',
    source: 'start',
  },
  {
    workloadId: 'wl-node',
    name: 'Node.js',
    paramSchema: [
      { key: 'version', label: '版本', type: 'select', options: ['20', '22'], defaultValue: '22' },
      { key: 'packages', label: '软件包', type: 'multi_select', options: ['pnpm', 'yarn'], defaultValue: ['pnpm'] },
      { key: 'debug', label: '调试', type: 'boolean', defaultValue: true },
      { key: 'name', label: '名称', type: 'text', defaultValue: 'demo' },
    ],
    dependsOnWorkloadIds: [],
    isPreset: false,
    installed: false,
  },
]

function mockWorkloads(items: CloudHostWorkloadItemData[] = workloads, options: { loading?: boolean } = {}) {
  mockUseQuery.mockReturnValue({
    data: options.loading ? null : { cloudHostWorkloads: items },
    loading: Boolean(options.loading),
    refetch: vi.fn(),
  })
}

function renderSection(overrides: Partial<typeof cloudHost> = {}) {
  return render(
    <CloudHostWorkloadsSection
      controllerId="ctrl-1"
      cloudHost={{ ...cloudHost, ...overrides }}
    />,
  )
}

describe('CloudHostWorkloadsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWorkloads()
    mockInstallWorkload.mockResolvedValue({
      data: {
        installCloudHostWorkload: {
          id: 'op-install-1',
          kind: 'INSTALL_WORKLOAD',
          status: 'RUNNING',
          steps: [{ key: 'workload', status: 'RUNNING', detail: 'Node.js' }],
          sessionId: null,
          error: null,
          createdAt: '',
          updatedAt: '',
        },
      },
    })
  })

  it('T-AW-G12 展示列表/预制/已安装徽标，已安装项禁用且无卸载入口', () => {
    renderSection()

    expect(screen.getByText('Github')).toBeInTheDocument()
    expect(screen.getByText('Node.js')).toBeInTheDocument()
    expect(screen.getAllByText('预制')).toHaveLength(1)
    expect(screen.getByText('已安装')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装 Github' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '安装 Node.js' })).not.toBeDisabled()
    expect(screen.queryByText(/卸载/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /卸载/ })).not.toBeInTheDocument()
  })

  it('T-AW-G12 参数表单按类型渲染并使用默认值', async () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: '安装 Node.js' }))

    expect(screen.getByLabelText('版本')).toHaveValue('22')
    expect(screen.getByLabelText('软件包 pnpm')).toBeChecked()
    expect(screen.getByLabelText('软件包 yarn')).not.toBeChecked()
    expect(screen.getByLabelText('调试')).toBeChecked()
    expect(screen.getByLabelText('名称')).toHaveValue('demo')
  })

  it('T-AW-G12 安装提交默认参数并打开单步进度对话框', async () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: '安装 Node.js' }))
    fireEvent.click(screen.getByRole('button', { name: '开始安装' }))

    await waitFor(() => {
      expect(mockInstallWorkload).toHaveBeenCalledWith({
        variables: {
          input: {
            controllerId: 'ctrl-1',
            workloadId: 'wl-node',
            params: {
              version: '22',
              packages: ['pnpm'],
              debug: true,
              name: 'demo',
            },
          },
        },
      })
    })

    const dialog = await screen.findByTestId('setup-progress-dialog')
    expect(dialog).toHaveAttribute('data-operation-id', 'op-install-1')
  })

  it('T-AW-G13 非 RUNNING 主机安装按钮禁用并提示', () => {
    renderSection({ status: 'STOPPED' })

    expect(screen.getByText('等待云电脑运行中')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装 Node.js' })).toBeDisabled()
  })

  it('展示正在安装的工作负载名', () => {
    renderSection({ workloadInstalling: 'Node.js' })

    expect(screen.getByTestId('workload-installing')).toHaveTextContent('安装中：Node.js')
  })

  it('安装失败时展示服务端错误', async () => {
    mockInstallWorkload.mockRejectedValueOnce(new Error('CONTAINER_BUSY'))
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: '安装 Node.js' }))
    fireEvent.click(screen.getByRole('button', { name: '开始安装' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('CONTAINER_BUSY')
  })

  it('查询加载期间展示加载态', () => {
    mockWorkloads([], { loading: true })
    renderSection()

    expect(screen.getByText('正在加载工作负载...')).toBeInTheDocument()
  })

  it('T-WEB-W1/W2: 按 workloadKind 分组展示并显示依赖名称', () => {
    mockWorkloads([
      {
        workloadId: 'wl-docker',
        name: 'Docker',
        workloadKind: 'STANDARD',
        paramSchema: [],
        dependsOnWorkloadIds: [],
        isPreset: false,
        installed: false,
      },
      {
        workloadId: 'wl-dotnet',
        name: '.NET',
        workloadKind: 'STANDARD',
        paramSchema: [],
        dependsOnWorkloadIds: [],
        isPreset: false,
        installed: false,
      },
      {
        workloadId: 'wl-aspire',
        name: 'Aspire',
        workloadKind: 'STANDARD',
        paramSchema: [],
        dependsOnWorkloadIds: ['wl-docker', 'wl-dotnet'],
        isPreset: false,
        installed: false,
      },
    ])
    renderSection()

    expect(screen.getByText('运行环境 / 工具')).toBeInTheDocument()
    expect(screen.queryByText('云电脑')).not.toBeInTheDocument()
    expect(screen.getByText('依赖：Docker、.NET')).toBeInTheDocument()
  })
})
