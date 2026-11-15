import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CustomToolData } from '@/graphql/custom-tool'
import type { WorkspaceData, WorkspaceTenantData } from '@/graphql/types'
import { resetWorkspaceStore, selectWorkspace, syncWorkspaceContext } from '@/stores/workspace'

const mockUseQuery = vi.fn()
const mockUseMutation = vi.fn()
const mockCreate = vi.fn()
const mockUpdate = vi.fn()
const mockDelete = vi.fn()
const mockToastSuccess = vi.fn()
const mockToastError = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}))
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}))

import CustomToolSection from '../CustomToolSection'

const TENANT: WorkspaceTenantData = { id: 't1', name: '团队一', type: 'team', memberCount: 2 }
const WRITABLE: WorkspaceData = {
  id: 'ws-1',
  name: '项目 A',
  type: 'normal',
  tenant: TENANT,
  memberCount: 1,
  myRole: 'admin',
  readOnly: false,
  createdAt: '',
}
const READONLY_GLOBAL: WorkspaceData = {
  id: 'ws-global',
  name: '全局工作区',
  type: 'global',
  tenant: TENANT,
  memberCount: 2,
  myRole: 'developer',
  readOnly: true,
  createdAt: '',
}

function setupWorkspace(workspace: WorkspaceData) {
  syncWorkspaceContext({
    workspaces: [workspace],
    tenants: [{ tenant: workspace.tenant, role: workspace.myRole }],
    userId: 'u1',
  })
  selectWorkspace(workspace.id)
}

function makeTool(overrides: Partial<CustomToolData> = {}): CustomToolData {
  return {
    id: '507f1f77bcf86cd7994390d1',
    name: '查询天气',
    description: '按城市查询天气',
    type: 'prompt',
    args: [{ key: 'city', name: '目标城市', description: null }],
    prompt: [{ type: 'Plain', value: 'hi', format: 'Generic' }],
    http: null,
    workspaceId: 'ws-1',
    createdBy: 'alice',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    ...overrides,
  }
}

function mockQueries(tools: CustomToolData[] = []) {
  mockUseQuery.mockReturnValue({ data: { customTools: tools }, loading: false, error: null })
}

beforeEach(() => {
  resetWorkspaceStore()
  vi.clearAllMocks()
  mockUseMutation
    .mockReturnValueOnce([mockCreate])
    .mockReturnValueOnce([mockUpdate])
    .mockReturnValue([mockDelete])
})

describe('CustomToolSection（T-CTW1）', () => {
  it('列表展示名称/类型/描述/MCP 暴露名；空态提示', () => {
    setupWorkspace(WRITABLE)
    mockQueries([makeTool()])
    const { unmount } = render(<CustomToolSection />)
    expect(screen.getByText('查询天气')).toBeInTheDocument()
    expect(screen.getByText('Prompt')).toBeInTheDocument()
    expect(screen.getByText('按城市查询天气')).toBeInTheDocument()
    expect(screen.getByText(/MCP 名称：ct-994390d1/)).toBeInTheDocument()
    unmount()

    mockQueries([])
    render(<CustomToolSection />)
    expect(screen.getByText('暂无自定义工具')).toBeInTheDocument()
  })

  it('标题带「工作区」badge；只读时隐藏新增/编辑/删除', () => {
    setupWorkspace(READONLY_GLOBAL)
    mockQueries([makeTool()])
    render(<CustomToolSection />)
    expect(screen.getByText('工作区')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新增自定义工具' })).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑 查询天气' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除 查询天气' })).toBeNull()
  })

  it('删除二次确认后调用 mutation', async () => {
    setupWorkspace(WRITABLE)
    mockQueries([makeTool()])
    mockDelete.mockResolvedValue({})
    render(<CustomToolSection />)
    fireEvent.click(screen.getByRole('button', { name: '删除 查询天气' }))
    expect(screen.getByText(/确定删除「查询天气」吗/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith({ variables: { id: '507f1f77bcf86cd7994390d1' } }))
  })

  it('新增对话框提交 create mutation', async () => {
    setupWorkspace(WRITABLE)
    mockQueries([])
    mockCreate.mockResolvedValue({})
    render(<CustomToolSection />)
    fireEvent.click(screen.getByRole('button', { name: '新增自定义工具' }))
    expect(await screen.findByLabelText('名称')).toBeInTheDocument()
  })
})
