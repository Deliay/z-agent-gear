import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ContinueWorkflowDialog from '../ContinueWorkflowDialog'
import type { WorkflowInstanceData } from '@/graphql/workflow'

const mockUseQuery = vi.fn()
const mockContinueWorkflowInstance = vi.fn()
const mockCreateWorkspace = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (mutation: unknown) => {
    const name = (mutation as { definitions?: Array<{ name?: { value?: string } }> }).definitions?.[0]?.name?.value
    return [name === 'ContinueWorkflowInstance' ? mockContinueWorkflowInstance : mockCreateWorkspace]
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/settings/AddWorkspaceDialog', () => ({
  default: ({ open, onSelect }: { open: boolean; onSelect: (path: string) => void }) =>
    open ? (
      <button type="button" onClick={() => onSelect('/new/path')}>
        选择目录
      </button>
    ) : null,
}))

function queryName(query: unknown): string {
  const definitions = (query as { definitions?: Array<{ name?: { value?: string } }> }).definitions ?? []
  return definitions[0]?.name?.value ?? ''
}

function makeInstance(overrides: Partial<WorkflowInstanceData> = {}): WorkflowInstanceData {
  return {
    id: 'inst-1',
    configuredWorkflowId: null,
    controllerId: 'old-ctrl',
    workspaceId: 'old-ws',
    name: '示例工作流',
    currentNodeNames: [],
    lastNodeName: null,
    lastNodeStatus: null,
    archived: false,
    unavailableReason: 'CONTROLLER_OFFLINE',
    workspace: { id: 'old-ws', name: '旧工作区' },
    controller: { id: 'old-ctrl', name: '旧主机' },
    workflowWorktreePath: null,
    workflowWorktreeBranch: null,
    nodes: [
      {
        id: 'n-ai-1',
        nodeKey: 'n1',
        type: 'AI',
        name: '方案',
        description: null,
        status: 'RUNNING',
        stage: '阶段',
        sessionId: null,
        prompts: null,
        artifactTitles: null,
        agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false },
        requiresWorktree: false,
        dependsOn: null,
        linkUpstreamPullRequest: false,
        sortOrder: null,
        createdAt: '',
        startedAt: null,
        reworkedAt: null,
        reworkCount: 0,
        retryCount: 0,
        nextRetryAt: null,
        rejectInfo: null,
        failInfo: null,
      },
      {
        id: 'n-ai-2',
        nodeKey: 'n2',
        type: 'AI',
        name: '实现',
        description: null,
        status: 'REWORK',
        stage: '阶段',
        sessionId: null,
        prompts: null,
        artifactTitles: null,
        agentConfig: { acpServerType: 'kimi_code', modeId: null, modelId: null, initNewWorktree: false },
        requiresWorktree: false,
        dependsOn: null,
        linkUpstreamPullRequest: false,
        sortOrder: null,
        createdAt: '',
        startedAt: null,
        reworkedAt: null,
        reworkCount: 1,
        retryCount: 0,
        nextRetryAt: null,
        rejectInfo: null,
        failInfo: null,
      },
      {
        id: 'n-ai-done',
        nodeKey: 'n3',
        type: 'AI',
        name: '已完成',
        description: null,
        status: 'DONE',
        stage: '阶段',
        sessionId: null,
        prompts: null,
        artifactTitles: null,
        agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false },
        requiresWorktree: false,
        dependsOn: null,
        linkUpstreamPullRequest: false,
        sortOrder: null,
        createdAt: '',
        startedAt: null,
        reworkedAt: null,
        reworkCount: 0,
        retryCount: 0,
        nextRetryAt: null,
        rejectInfo: null,
        failInfo: null,
      },
      {
        id: 'n-human',
        nodeKey: 'n4',
        type: 'HUMAN',
        name: '验收',
        description: null,
        status: 'READY',
        stage: '阶段',
        sessionId: null,
        prompts: null,
        artifactTitles: null,
        agentConfig: null,
        requiresWorktree: false,
        dependsOn: null,
        linkUpstreamPullRequest: false,
        sortOrder: null,
        createdAt: '',
        startedAt: null,
        reworkedAt: null,
        reworkCount: 0,
        retryCount: 0,
        nextRetryAt: null,
        rejectInfo: null,
        failInfo: null,
      },
    ],
    blackboard: [],
    blackboardTrash: [],
    additionalPrompts: [],
    pullRequestLinks: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

interface QueryFixtures {
  controllers?: Array<{ id: string; name: string; status: string }>
  workspaces?: Array<Record<string, unknown>>
  capabilities?: Array<{ type: string; available: boolean }>
  git?: { isGitRepo: boolean }
  refetchWorkspaces?: () => Promise<unknown>
}

function mockQueries(fixtures: QueryFixtures = {}) {
  const {
    controllers = [
      { id: 'ctrl-a', name: '新主机A', status: 'online' },
      { id: 'ctrl-c', name: '新主机C', status: 'online' },
      { id: 'old-ctrl', name: '旧主机', status: 'offline' },
    ],
    workspaces = [
      { id: 'ws-a', controllerId: 'ctrl-a', name: '目标工作区', path: '/repo/a', isEnabled: true },
      { id: 'ws-c', controllerId: 'ctrl-c', name: 'C 工作区', path: '/repo/c', isEnabled: true },
      { id: 'ws-disabled', controllerId: 'ctrl-a', name: '禁用工作区', path: '/repo/x', isEnabled: false },
    ],
    capabilities = [
      { type: 'opencode', available: true },
      { type: 'kimi_code', available: true },
      { type: 'cursor', available: false },
    ],
    git = { isGitRepo: true },
    refetchWorkspaces = vi.fn().mockResolvedValue(undefined),
  } = fixtures

  mockUseQuery.mockImplementation((query: unknown, options?: { skip?: boolean }) => {
    if (options?.skip) return { data: undefined }
    const name = queryName(query)
    if (name === 'GetControllers') return { data: { controllers } }
    if (name === 'GetWorkspaces') return { data: { workspaces }, refetch: refetchWorkspaces }
    if (name === 'GetAcpCapabilities') return { data: { acpCapabilities: capabilities } }
    if (name === 'DetectGitRepo') return { data: { detectGitRepo: git } }
    return { data: undefined }
  })
  return { refetchWorkspaces }
}

function renderDialog(instance = makeInstance()) {
  return render(<ContinueWorkflowDialog open onOpenChange={vi.fn()} instance={instance} />)
}

async function selectWorkspaceOption(name: string) {
  fireEvent.click(screen.getByRole('combobox', { name: '工作路径' }))
  const option = await screen.findByRole('option', { name })
  fireEvent.pointerDown(option, { pointerType: 'mouse' })
  fireEvent.click(option)
}

describe('ContinueWorkflowDialog（T-WEB2/3/4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockContinueWorkflowInstance.mockResolvedValue({ data: { continueWorkflowInstance: { id: 'inst-1', unavailableReason: null } } })
    mockCreateWorkspace.mockResolvedValue({ data: { createWorkspace: { id: 'ws-new' } } })
  })

  it('T-WEB2a 默认值：Worktree 勾选、只列出未完成 AI 节点并默认沿用原 Harness', async () => {
    mockQueries()
    renderDialog()

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '新控制器' })).toHaveTextContent('新主机A'),
    )
    expect(screen.getByRole('checkbox', { name: '创建新 Worktree' })).toBeChecked()
    expect(screen.getByTestId('harness-mapping-n-ai-1')).toBeInTheDocument()
    expect(screen.getByTestId('harness-mapping-n-ai-2')).toBeInTheDocument()
    expect(screen.queryByTestId('harness-mapping-n-ai-done')).not.toBeInTheDocument()
    expect(screen.queryByTestId('harness-mapping-n-human')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '方案 Harness' })).toHaveTextContent('opencode')
    expect(screen.getByRole('combobox', { name: '实现 Harness' })).toHaveTextContent('kimi_code')
  })

  it('T-WEB2b 原 Harness 不在能力清单：留空并提示改选', async () => {
    mockQueries({ capabilities: [{ type: 'opencode', available: true }] })
    renderDialog()

    expect(screen.getByRole('combobox', { name: '实现 Harness' })).toHaveTextContent('请选择 Harness')
    expect(screen.getByText('原 Harness 不可用，请改选')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认接续' })).toBeDisabled()
  })

  it('T-WEB3 门控：未选工作路径禁用；非 Git 勾选 Worktree 禁用并提示；就绪后提交映射', async () => {
    mockQueries()
    renderDialog()

    await waitFor(() => expect(screen.getByRole('combobox', { name: '新控制器' })).toHaveTextContent('新主机A'))
    expect(screen.getByRole('button', { name: '确认接续' })).toBeDisabled()

    await selectWorkspaceOption('目标工作区')
    expect(screen.getByRole('button', { name: '确认接续' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '确认接续' }))
    await waitFor(() => expect(mockContinueWorkflowInstance).toHaveBeenCalledTimes(1))
    expect(mockContinueWorkflowInstance.mock.calls[0][0]).toMatchObject({
      variables: {
        id: 'inst-1',
        input: {
          controllerId: 'ctrl-a',
          workspaceId: 'ws-a',
          createWorkflowWorktree: true,
          harnessMappings: [
            { nodeId: 'n-ai-1', acpServerType: 'opencode' },
            { nodeId: 'n-ai-2', acpServerType: 'kimi_code' },
          ],
        },
      },
    })
  })

  it('T-WEB3b 非 Git 工作区：勾选 Worktree 时置灰并禁止提交', async () => {
    mockQueries({ git: { isGitRepo: false } })
    renderDialog()

    await waitFor(() => expect(screen.getByRole('combobox', { name: '新控制器' })).toHaveTextContent('新主机A'))
    await selectWorkspaceOption('目标工作区')

    expect(screen.getByRole('checkbox', { name: '创建新 Worktree' })).toBeDisabled()
    expect(screen.getByText('目标路径不是 Git 仓库，无法创建 Worktree')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认接续' })).toBeDisabled()
  })

  it('T-WEB4 浏览目录新建工作区：调用 CREATE_WORKSPACE 并选中新工作区；切换控制器重置', async () => {
    const { refetchWorkspaces } = mockQueries()
    renderDialog()

    await waitFor(() => expect(screen.getByRole('combobox', { name: '新控制器' })).toHaveTextContent('新主机A'))
    await selectWorkspaceOption('目标工作区')

    fireEvent.click(screen.getByRole('button', { name: '浏览目录新建…' }))
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))

    await waitFor(() =>
      expect(mockCreateWorkspace).toHaveBeenCalledWith({
        variables: { input: { controllerId: 'ctrl-a', path: '/new/path' } },
      }),
    )
    expect(refetchWorkspaces).toHaveBeenCalled()

    // 切换控制器：工作路径与 Harness 覆盖重置
    fireEvent.click(screen.getByRole('combobox', { name: '新控制器' }))
    const option = await screen.findByRole('option', { name: '新主机C' })
    fireEvent.pointerDown(option, { pointerType: 'mouse' })
    fireEvent.click(option)

    expect(screen.getByRole('combobox', { name: '工作路径' })).toHaveTextContent('选择工作路径')
    expect(screen.getByRole('combobox', { name: '方案 Harness' })).toHaveTextContent('opencode')
  })
})
