import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import ModelSection from '../ModelSection'
import { MODEL_CONFIG_APPLIED_NOTICE } from '@/lib/model-config-notice'
import { resetWorkspaceStore } from '@/stores/workspace'

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
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
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
  toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn() },
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
    isCustom: true,
    isEnabled: true,
    sortOrder: 0,
    contextLength: 128000,
    scope: 'user',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function setupQueries(models: unknown[]) {
  mocks.settings.mockReturnValue({
    data: { models, providers: [{ id: 'p1', name: 'My OpenAI', type: 'OpenAI', isEnabled: true }] },
    loading: false,
  })
}

function expandGroup(title: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }))
}

function assertAppliedNotice() {
  expect(mocks.toastSuccess).toHaveBeenCalled()
  const messages = mocks.toastSuccess.mock.calls.map((call) => call[0])
  expect(messages).toContain(MODEL_CONFIG_APPLIED_NOTICE)
}

describe('ModelSection 下发提醒（T-MCWEB4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkspaceStore()
    mocks.loadOptions.mockResolvedValue({ data: { providerModelOptions: [] } })
    mocks.toggle.mockResolvedValue({})
    mocks.sort.mockResolvedValue({})
    mocks.create.mockResolvedValue({})
    mocks.update.mockResolvedValue({})
    mocks.remove.mockResolvedValue({})
  })

  it('新增自定义模型成功后提示已下发', async () => {
    setupQueries([model('u1')])
    render(<ModelSection />)

    fireEvent.click(screen.getByRole('button', { name: '自定义模型' }))
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'new-model' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    await waitFor(() => assertAppliedNotice())
  })

  it('启停成功后提示已下发', async () => {
    setupQueries([model('u1')])
    render(<ModelSection />)
    expandGroup('My OpenAI')

    fireEvent.click(screen.getByRole('switch', { name: '启用 model-u1' }))

    await waitFor(() => expect(mocks.toggle).toHaveBeenCalled())
    await waitFor(() => assertAppliedNotice())
  })

  it('删除成功后提示已下发', async () => {
    setupQueries([model('u1')])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ModelSection />)
    expandGroup('My OpenAI')

    fireEvent.click(screen.getByTitle('删除自定义模型'))

    await waitFor(() => expect(mocks.remove).toHaveBeenCalled())
    await waitFor(() => assertAppliedNotice())
    confirm.mockRestore()
  })

  it('排序成功后提示已下发', async () => {
    setupQueries([model('u1'), model('u2')])
    render(<ModelSection />)

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'u2' }, over: { id: 'u1' } })
    })

    expect(mocks.sort).toHaveBeenCalled()
    assertAppliedNotice()
  })

  it('上下文编辑成功后提示已下发', async () => {
    setupQueries([model('u1')])
    render(<ModelSection />)
    expandGroup('My OpenAI')

    fireEvent.click(screen.getByLabelText('编辑上下文'))
    fireEvent.change(screen.getByLabelText('最长上下文大小（token）'), {
      target: { value: '200000' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    await waitFor(() => assertAppliedNotice())
  })

  it('上下文编辑失败：保留错误提示，无成功 toast', async () => {
    setupQueries([model('u1')])
    mocks.update.mockRejectedValue(new Error('boom'))
    render(<ModelSection />)
    expandGroup('My OpenAI')

    fireEvent.click(screen.getByLabelText('编辑上下文'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('新增失败：无成功 toast', async () => {
    setupQueries([model('u1')])
    mocks.create.mockRejectedValue(new Error('boom'))
    render(<ModelSection />)

    fireEvent.click(screen.getByRole('button', { name: '自定义模型' }))
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'new-model' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
