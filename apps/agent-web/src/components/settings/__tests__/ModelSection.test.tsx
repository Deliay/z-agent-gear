import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import ModelSection from '../ModelSection'
import { resetWorkspaceStore, selectWorkspace, syncWorkspaceContext } from '../../../stores/workspace'

const dnd = vi.hoisted(() => ({ onDragEnd: null as null | ((event: unknown) => void) }))

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  settings: vi.fn(),
  toggle: vi.fn(),
  sort: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  loadOptions: vi.fn(),
}))

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}))

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useLazyQuery: () => [mocks.loadOptions, { loading: false }],
  useMutation: (doc: unknown) => {
    const source = String(doc)
    if (source.includes('ToggleModel')) return [mocks.toggle, { loading: false }]
    if (source.includes('SortOrder')) return [mocks.sort, { loading: false }]
    if (source.includes('CreateCustomModel')) return [mocks.create, { loading: false }]
    if (source.includes('UpdateModelContextLength')) return [mocks.update, { loading: false }]
    if (source.includes('DeleteCustomModel')) return [mocks.remove, { loading: false }]
    return [vi.fn(), { loading: false }]
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/stores/settingsOverview', () => ({
  useSettingsOverview: () => mocks.settings(),
}))

vi.mock('@dnd-kit/core', async () => {
  const React = await import('react')
  return {
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode
      onDragEnd: (event: unknown) => void
    }) => {
      dnd.onDragEnd = onDragEnd
      return React.createElement('div', null, children)
    },
    closestCenter: () => {},
    PointerSensor: function PointerSensor() {},
    useSensor: () => ({}),
    useSensors: () => [],
  }
})

vi.mock('@dnd-kit/sortable', async () => {
  const React = await import('react')
  return {
    SortableContext: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    verticalListSortingStrategy: {},
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      transition: null,
      isDragging: false,
    }),
  }
})

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}))

function model(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    providerId: 'p1',
    provider: { id: 'p1', name: 'My OpenAI', type: 'OpenAI', isEnabled: true },
    name: `model-${id}`,
    isCustom: false,
    isEnabled: true,
    sortOrder: 0,
    scope: 'user',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function setupQueries(models: unknown[], providers: unknown[] = []) {
  mocks.settings.mockReturnValue({ data: { models, providers }, loading: false })
}

function expandGroup(title: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }))
}

describe('agent-web ModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetWorkspaceStore()
    mocks.loadOptions.mockResolvedValue({ data: { providerModelOptions: [] } })
  })

  it('T-AW1: puts global models into a first 系统内置 group, collapsed by default', () => {
    setupQueries([
      model('u1'),
      model('g1', { scope: 'global', providerId: 'gp', provider: { id: 'gp', name: 'Backend OpenAI', type: 'OpenAI', isEnabled: true } }),
    ])
    render(<ModelSection />)

    const headers = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-expanded'))
    expect(headers[0].textContent).toContain('系统内置')
    expect(headers[0]).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('model-g1')).toBeNull()
  })

  it('T-AW2: groups user models by provider, collapsed by default', () => {
    setupQueries([
      model('u1'),
      model('u2', { providerId: 'p2', provider: { id: 'p2', name: 'Another', type: 'OpenAI', isEnabled: true } }),
    ])
    render(<ModelSection />)

    expect(screen.getByRole('button', { name: /My OpenAI/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /Another/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('model-u1')).toBeNull()
  })

  it('T-AW3: never leaks the backend provider name in the 系统内置 group', () => {
    setupQueries([model('g1', { scope: 'global', provider: { id: 'gp', name: 'Backend OpenAI', type: 'OpenAI', isEnabled: true } })])
    render(<ModelSection />)
    expandGroup('系统内置')

    expect(screen.getByText('model-g1')).toBeDefined()
    expect(screen.queryByText('Backend OpenAI')).toBeNull()
  })

  it('T-AW4: global models are read-only (no drag handle, no delete, disabled switch) and keep their real state', () => {
    setupQueries([
      model('g1', { scope: 'global' }),
      model('g2', { scope: 'global', isEnabled: false }),
    ])
    render(<ModelSection />)
    expandGroup('系统内置')

    expect(screen.queryByLabelText('拖动排序')).toBeNull()
    expect(screen.queryByTitle('删除自定义模型')).toBeNull()

    const enabledSwitch = screen.getByRole('switch', { name: '启用 model-g1' })
    const disabledSwitch = screen.getByRole('switch', { name: '启用 model-g2' })
    expect(enabledSwitch).toHaveAttribute('aria-disabled', 'true')
    expect(enabledSwitch).toHaveAttribute('aria-checked', 'true')
    expect(disabledSwitch).toHaveAttribute('aria-disabled', 'true')
    expect(disabledSwitch).toHaveAttribute('aria-checked', 'false')
  })

  it('T-AW8: merges dangling-provider models into a single 未知供应商 group', () => {
    setupQueries([
      model('x1', { providerId: 'gone-1', provider: undefined }),
      model('x2', { providerId: 'gone-2', provider: undefined }),
    ])
    render(<ModelSection />)

    const headers = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-expanded'))
    expect(headers).toHaveLength(1)
    expect(headers[0].textContent).toContain('未知供应商')
    expect(headers[0].textContent).toContain('2')

    expandGroup('未知供应商')
    expect(screen.getByText('model-x1')).toBeDefined()
    expect(screen.getByText('model-x2')).toBeDefined()
  })

  it('T-AW5: submits only user model ids after a user-group drag', async () => {
    setupQueries([model('u1'), model('u2'), model('g1', { scope: 'global' })])
    render(<ModelSection />)

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'u2' }, over: { id: 'u1' } })
    })

    expect(mocks.sort).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { ids: ['u2', 'u1'] } }),
    )
    const ids = (mocks.sort.mock.calls[0][0] as { variables: { ids: string[] } }).variables.ids
    expect(ids).not.toContain('g1')
  })

  it('T-AW6: ignores a cross-group drag', async () => {
    setupQueries([
      model('u1'),
      model('u2', { providerId: 'p2', provider: { id: 'p2', name: 'Another', type: 'OpenAI', isEnabled: true } }),
    ])
    render(<ModelSection />)

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'u1' }, over: { id: 'u2' } })
    })

    expect(mocks.sort).not.toHaveBeenCalled()
  })

  it('T-AW7: keeps the expanded state across a refetch rerender', () => {
    setupQueries([model('u1')])
    const { rerender } = render(<ModelSection />)

    expandGroup('My OpenAI')
    expect(screen.getByText('model-u1')).toBeDefined()

    rerender(<ModelSection />)
    expect(screen.getByText('model-u1')).toBeDefined()
  })

  it('T-AW9: user custom models keep delete, toggle and drag capabilities', async () => {
    setupQueries([
      model('u1', { isCustom: true }),
      model('u2', { isCustom: true }),
    ])
    mocks.toggle.mockResolvedValue({})
    mocks.remove.mockResolvedValue({})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ModelSection />)
    expandGroup('My OpenAI')

    const sw = screen.getByRole('switch', { name: '启用 model-u1' })
    expect(sw).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(sw)
    await waitFor(() => expect(mocks.toggle).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { id: 'u1' } }),
    ))

    fireEvent.click(screen.getAllByTitle('删除自定义模型')[0])
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { id: 'u1' } }),
    ))
    expect(confirm).toHaveBeenCalled()

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'u2' }, over: { id: 'u1' } })
    })
    expect(mocks.sort).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { ids: ['u2', 'u1'] } }),
    )
    confirm.mockRestore()
  })

  it('T-AW10: recomputes user ids from the latest groups at drag end (groupsRef, C-12)', async () => {
    let currentModels = [model('u1'), model('u2')]
    mocks.settings.mockImplementation(() => ({
      data: { models: currentModels, providers: [] },
      loading: false,
    }))

    const { rerender } = render(<ModelSection />)
    const staleHandler = dnd.onDragEnd

    currentModels = [model('u1'), model('u2'), model('u3')]
    rerender(<ModelSection />)

    await act(async () => {
      staleHandler?.({ active: { id: 'u2' }, over: { id: 'u1' } })
    })

    expect(mocks.sort).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { ids: ['u2', 'u1', 'u3'] } }),
    )
  })

  it('shows the empty state', () => {
    setupQueries([])
    render(<ModelSection />)
    expect(screen.getByText('暂无可用模型，添加供应商后自动同步模型')).toBeDefined()
  })

  it('混合来源组不展示组头单一徽标，逐模型展示来源', () => {
    resetWorkspaceStore()
    const tenant = { id: 't1', name: '团队', type: 'team' as const, memberCount: 2 }
    const globalWs = {
      id: 'g1', name: '全局工作区', type: 'global' as const, tenant,
      memberCount: 2, myRole: 'admin' as const, readOnly: false, createdAt: '',
    }
    const normalWs = {
      id: 'w1', name: '项目 A', type: 'normal' as const, tenant,
      memberCount: 1, myRole: 'admin' as const, readOnly: false, createdAt: '',
    }
    syncWorkspaceContext({
      workspaces: [globalWs, normalWs],
      tenants: [{ tenant, role: 'admin' }],
      userId: 'u1',
    })
    selectWorkspace('w1')
    setupQueries([
      model('a', { workspaceId: 'w1' }),
      model('b', { workspaceId: 'g1' }),
    ])
    render(<ModelSection />)
    expandGroup('My OpenAI')
    // 组头不展示单一来源徽标；行内分别展示「本工作区」「全局工作区」
    expect(screen.getAllByText('本工作区')).toHaveLength(1)
    expect(screen.getAllByText('全局工作区')).toHaveLength(1)
  })

  // ---------- T-MCWEB1：上下文长度展示与编辑上下文 ----------

  it('T-MCWEB1a: 行内展示最长上下文（数值 / 未设置）', () => {
    setupQueries([
      model('u1', { contextLength: 200000 }),
      model('u2', { contextLength: null }),
    ])
    render(<ModelSection />)
    expandGroup('My OpenAI')

    expect(screen.getByText('最长上下文：200,000 tokens')).toBeDefined()
    expect(screen.getByText('最长上下文：未设置')).toBeDefined()
  })

  it('T-MCWEB1b: 编辑入口仅用户模型且非只读可见', () => {
    setupQueries([
      model('u1'),
      model('g1', { scope: 'global', provider: { id: 'gp', name: 'Backend', type: 'OpenAI', isEnabled: true } }),
    ])
    render(<ModelSection />)

    expandGroup('系统内置')
    expect(screen.queryByLabelText('编辑上下文')).toBeNull()

    expandGroup('My OpenAI')
    expect(screen.getByLabelText('编辑上下文')).toBeDefined()
  })

  it('T-MCWEB1b2: 只读上下文隐藏编辑入口', () => {
    resetWorkspaceStore()
    const tenant = { id: 't1', name: '团队', type: 'team' as const, memberCount: 2 }
    const readOnlyGlobal = {
      id: 'g1', name: '全局工作区', type: 'global' as const, tenant,
      memberCount: 2, myRole: 'developer' as const, readOnly: true, createdAt: '',
    }
    syncWorkspaceContext({
      workspaces: [readOnlyGlobal],
      tenants: [{ tenant, role: 'developer' }],
      userId: 'u1',
    })
    selectWorkspace('g1')
    setupQueries([model('u1', { workspaceId: 'g1' })])
    render(<ModelSection />)
    expandGroup('My OpenAI')

    expect(screen.getByText('model-u1')).toBeDefined()
    expect(screen.queryByLabelText('编辑上下文')).toBeNull()
  })

  it('T-MCWEB1c: 编辑保存调用 UPDATE_MODEL_CONTEXT_LENGTH（数值 / null）', async () => {
    setupQueries([model('u1', { contextLength: 128000 })])
    mocks.update.mockResolvedValue({})
    render(<ModelSection />)
    expandGroup('My OpenAI')

    fireEvent.click(screen.getByLabelText('编辑上下文'))
    // 编辑模式：供应商与名称只读展示（行内 + 对话框各一处）
    expect(screen.getByText('编辑模型')).toBeDefined()
    expect(screen.getAllByText('model-u1')).toHaveLength(2)
    const input = screen.getByLabelText('最长上下文大小（token）')
    expect(input).toHaveValue('128000')

    fireEvent.change(input, { target: { value: '200000' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { modelId: 'u1', contextLength: 200000 },
        }),
      ),
    )

    // 再次打开并清空 → 提交 null
    fireEvent.click(screen.getByLabelText('编辑上下文'))
    fireEvent.change(screen.getByLabelText('最长上下文大小（token）'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variables: { modelId: 'u1', contextLength: null },
        }),
      ),
    )
  })

  it('T-MCWEB1d: 非法上下文提示且不发 mutation', () => {
    setupQueries([model('u1')])
    render(<ModelSection />)
    expandGroup('My OpenAI')

    fireEvent.click(screen.getByLabelText('编辑上下文'))
    fireEvent.change(screen.getByLabelText('最长上下文大小（token）'), {
      target: { value: '0' },
    })

    expect(screen.getByText('请输入正整数')).toBeDefined()
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('T-MCWEB1e: 新增自定义模型携带 contextLength', async () => {
    setupQueries([model('u1')], [
      { id: 'p1', name: 'My OpenAI', type: 'OpenAI', isEnabled: true, models: [] },
    ])
    mocks.create.mockResolvedValue({})
    render(<ModelSection />)

    fireEvent.click(screen.getByRole('button', { name: '自定义模型' }))
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'new-model' } })
    fireEvent.change(screen.getByLabelText('最长上下文大小（token）'), {
      target: { value: '128000' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      variables: { input: { providerId: 'p1', name: 'new-model', contextLength: 128000 } },
    })
  })
})
