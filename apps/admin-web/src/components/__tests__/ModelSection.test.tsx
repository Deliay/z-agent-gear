import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import ModelSection from '../models/ModelSection'
import CustomModelDialog from '../models/CustomModelDialog'

const dnd = vi.hoisted(() => ({ onDragEnd: null as null | ((event: unknown) => void) }))

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetch: vi.fn(),
  toggle: vi.fn(),
  sort: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}))

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (doc: unknown) => {
    const source = String(doc)
    if (source.includes('ToggleGlobalModel')) return [mocks.toggle, { loading: false }]
    if (source.includes('SortOrder')) return [mocks.sort, { loading: false }]
    if (source.includes('CreateGlobalCustomModel')) return [mocks.create, { loading: false }]
    if (source.includes('DeleteGlobalModel')) return [mocks.remove, { loading: false }]
    return [vi.fn(), { loading: false }]
  },
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn() },
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
    provider: { id: 'p1', name: 'My OpenAI', type: 'OpenAI', isEnabled: true, scope: 'global' },
    name: `model-${id}`,
    isCustom: false,
    isEnabled: true,
    sortOrder: 0,
    scope: 'global',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function setupQueries(models: unknown[], providers: unknown[] = []) {
  mocks.useQuery.mockImplementation((doc: unknown) => {
    if (String(doc).includes('adminProviders')) {
      return { data: { adminProviders: providers }, loading: false, error: undefined, refetch: mocks.refetch }
    }
    return { data: { adminModels: models }, loading: false, error: undefined, refetch: mocks.refetch }
  })
}

/** 默认全部折叠：测试需要读取组内内容时先展开所有组 */
function expandAllGroups() {
  document.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]').forEach((button) => {
    fireEvent.click(button)
  })
}

function expandGroup(title: string) {
  const header = screen.getByRole('button', { name: new RegExp(title) })
  fireEvent.click(header)
}

describe('ModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T-W24: refreshes provider model counts after creating a custom model (C-4)', async () => {
    setupQueries([model('a')], [{ id: 'p1', name: 'My OpenAI', type: 'OpenAI', isEnabled: true, scope: 'global', models: [] }])
    mocks.create.mockResolvedValue({})
    render(<ModelSection />)

    fireEvent.click(screen.getByRole('button', { name: '自定义模型' }))
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'new-model' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    const options = mocks.create.mock.calls[0][0] as { refetchQueries: unknown[] }
    expect(options.refetchQueries).toHaveLength(2)
    expect(options.refetchQueries.map((doc) => String(doc)).join('\n')).toContain('adminProviders')
  })

  it('T-W2: sends the reordered ids to updateGlobalModelSortOrder on drag end', async () => {
    setupQueries([model('a'), model('b'), model('c')])
    render(<ModelSection />)

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'c' }, over: { id: 'a' } })
    })

    expect(mocks.sort).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { ids: ['c', 'a', 'b'] } }),
    )
  })

  it('T-W23: preserves other groups relative order when saving a reordered group (C-1)', async () => {
    setupQueries([
      model('a'),
      model('x', { providerId: 'p2', provider: { id: 'p2', name: 'Other', type: 'OpenAI', isEnabled: true, scope: 'global' } }),
      model('b'),
      model('y', { providerId: 'p2', provider: { id: 'p2', name: 'Other', type: 'OpenAI', isEnabled: true, scope: 'global' } }),
    ])
    render(<ModelSection />)

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'b' }, over: { id: 'a' } })
    })

    // 只替换 p1 组在全局顺序中的位置，p2 的 x/y 保持原位（不是按组拼接 [b,a,x,y]）
    expect(mocks.sort).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { ids: ['b', 'x', 'a', 'y'] } }),
    )
  })

  it('T-W9: recomputes ids from the latest list at send time (no stale closure)', async () => {    let currentModels = [model('a'), model('b'), model('c')]
    mocks.useQuery.mockImplementation((doc: unknown) => {
      if (String(doc).includes('adminProviders')) {
        return { data: { adminProviders: [] }, loading: false, error: undefined, refetch: mocks.refetch }
      }
      return { data: { adminModels: currentModels }, loading: false, error: undefined, refetch: mocks.refetch }
    })

    const { rerender } = render(<ModelSection />)
    const staleHandler = dnd.onDragEnd

    currentModels = [model('a'), model('b'), model('c'), model('d')]
    rerender(<ModelSection />)

    await act(async () => {
      staleHandler?.({ active: { id: 'c' }, over: { id: 'a' } })
    })

    expect(mocks.sort).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { ids: ['c', 'a', 'b', 'd'] } }),
    )
  })

  it('T-W6: groups by provider and collapses by default', () => {
    setupQueries([
      model('a'),
      model('b', { providerId: 'p2', provider: { id: 'p2', name: 'Other', type: 'OpenAI', isEnabled: true, scope: 'global' } }),
    ])
    render(<ModelSection />)

    expect(screen.getByRole('button', { name: /My OpenAI/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /Other/ })).toHaveAttribute('aria-expanded', 'false')
    // 组内模型初始不渲染
    expect(screen.queryByText('model-a')).toBeNull()

    expandGroup('My OpenAI')
    expect(screen.getByText('model-a')).toBeDefined()
    expect(screen.queryByText('model-b')).toBeNull()
  })

  it('T-W7: merges models with different dangling providerIds into a single 未知供应商 group', () => {
    setupQueries([
      model('x1', { providerId: '', provider: undefined, name: 'orphan-1' }),
      model('x2', { providerId: 'gone-2', provider: undefined, name: 'orphan-2' }),
    ])
    render(<ModelSection />)

    const headers = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-expanded'))
    expect(headers).toHaveLength(1)
    expect(headers[0].textContent).toContain('未知供应商')
    expect(headers[0].textContent).toContain('2')

    expandAllGroups()
    expect(screen.getByText('orphan-1')).toBeDefined()
    expect(screen.getByText('orphan-2')).toBeDefined()
  })

  it('T-W8: ignores a cross-group drag', async () => {
    setupQueries([
      model('a'),
      model('b', { providerId: 'p2', provider: { id: 'p2', name: 'Other', type: 'OpenAI', isEnabled: true, scope: 'global' } }),
    ])
    render(<ModelSection />)

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'a' }, over: { id: 'b' } })
    })

    expect(mocks.sort).not.toHaveBeenCalled()
  })

  it('T-W10: every model exposes a delete entry (including imported models)', async () => {
    setupQueries([model('a'), model('b', { isCustom: true, name: 'my-custom' })])
    mocks.remove.mockResolvedValue({})
    render(<ModelSection />)
    expandAllGroups()

    expect(screen.getAllByTitle('删除模型')).toHaveLength(2)

    fireEvent.click(screen.getAllByTitle('删除模型')[0])
    expect(screen.getByText('删除模型')).toBeDefined()
    expect(screen.getByText(/删除后前台不再展示/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'a' } }),
      ),
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith('模型已删除')
  })

  it('T-W6: disables the switch when the parent provider is disabled but keeps the real state', () => {
    setupQueries([
      model('a', { provider: { id: 'p1', name: 'Disabled', type: 'OpenAI', isEnabled: false, scope: 'global' } }),
    ])
    render(<ModelSection />)
    expandAllGroups()

    const sw = screen.getByRole('switch', { name: '启用 model-a' })
    expect(sw).toHaveAttribute('aria-disabled', 'true')
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('供应商已禁用')).toBeDefined()
  })

  it('T-W11: shows the manual-import empty state when there are no models', () => {
    setupQueries([])
    render(<ModelSection />)
    expect(screen.getByText('暂无可用模型，通过供应商的「导入模型」手动导入')).toBeDefined()
  })

  it('T-W5: renders an error state with retry when the models query fails', () => {
    mocks.useQuery.mockImplementation((doc: unknown) => {
      if (String(doc).includes('adminProviders')) {
        return { data: { adminProviders: [] }, loading: false, error: undefined, refetch: mocks.refetch }
      }
      return { data: undefined, loading: false, error: new Error('adminModels boom'), refetch: mocks.refetch }
    })
    render(<ModelSection />)

    expect(screen.getByRole('alert').textContent).toContain('adminModels boom')
    expect(screen.queryByText('暂无可用模型，通过供应商的「导入模型」手动导入')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('T-W1: surfaces a refresh failure via toast while keeping the loaded list', () => {
    mocks.useQuery.mockImplementation((doc: unknown) => {
      if (String(doc).includes('adminProviders')) {
        return { data: { adminProviders: [] }, loading: false, error: undefined, refetch: mocks.refetch }
      }
      return {
        data: { adminModels: [model('a')] },
        loading: false,
        error: new Error('adminModels refresh boom'),
        refetch: mocks.refetch,
      }
    })
    render(<ModelSection />)

    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining('adminModels refresh boom'),
    )
    expect(screen.getByRole('button', { name: /My OpenAI/ })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('T-W1: consumes the providers query error', () => {
    mocks.useQuery.mockImplementation((doc: unknown) => {
      if (String(doc).includes('adminProviders')) {
        return {
          data: undefined,
          loading: false,
          error: new Error('providers boom'),
          refetch: mocks.refetch,
        }
      }
      return { data: { adminModels: [model('a')] }, loading: false, error: undefined, refetch: mocks.refetch }
    })
    render(<ModelSection />)

    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('providers boom'))
  })

  it('T-W1: ignores repeated switch toggles while in flight', async () => {
    setupQueries([model('a')])
    let resolveToggle: (value: unknown) => void = () => {}
    mocks.toggle.mockImplementation(
      () => new Promise((resolve) => {
        resolveToggle = resolve
      }),
    )

    render(<ModelSection />)
    expandAllGroups()
    const sw = screen.getByRole('switch', { name: '启用 model-a' })
    fireEvent.click(sw)
    await waitFor(() => expect(mocks.toggle).toHaveBeenCalledTimes(1))

    expect(sw).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(sw)
    expect(mocks.toggle).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveToggle({})
    })
  })
})

describe('CustomModelDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T-W16: blocks a duplicate name locally and disables save', () => {
    const onSave = vi.fn()
    render(
      <CustomModelDialog
        open
        onOpenChange={() => {}}
        providers={[{ id: 'p1', name: 'My OpenAI' }]}
        existingNames={['gpt-4o']}
        onSave={onSave}
      />,
    )

    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'gpt-4o' } })

    expect(screen.getByText('模型名已存在')).toBeDefined()
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('computes the duplicate check after trimming', () => {
    render(
      <CustomModelDialog
        open
        onOpenChange={() => {}}
        providers={[{ id: 'p1', name: 'My OpenAI' }]}
        existingNames={['gpt-4o']}
        onSave={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: '  gpt-4o  ' } })
    expect(screen.getByText('模型名已存在')).toBeDefined()
  })

  it('T-W3: surfaces the duplicate-name error from the mutation', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Model name already exists: gpt-4o'))
    render(
      <CustomModelDialog
        open
        onOpenChange={() => {}}
        providers={[{ id: 'p1', name: 'My OpenAI' }]}
        onSave={onSave}
      />,
    )

    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'gpt-4o' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Model name already exists: gpt-4o',
      ),
    )
  })
})
