import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ImportModelsDialog from '../models/ImportModelsDialog'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetch: vi.fn(),
  importModels: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}))

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: () => [mocks.importModels, { loading: false }],
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn() },
}))

const options = [
  { name: 'gpt-4o', isImported: false, isDuplicate: false },
  { name: 'gpt-4o-mini', isImported: false, isDuplicate: false },
  { name: 'claude', isImported: true, isDuplicate: false },
  { name: 'taken-by-other', isImported: false, isDuplicate: true },
]

function setup(overrides: { loading?: boolean; error?: Error | null; data?: unknown } = {}) {
  mocks.useQuery.mockReturnValue({
    data: overrides.error ? undefined : { listGlobalProviderModels: overrides.data ?? options },
    loading: overrides.loading ?? false,
    error: overrides.error ?? undefined,
    refetch: mocks.refetch,
  })
}

function renderDialog() {
  return render(
    <ImportModelsDialog
      open
      onOpenChange={() => {}}
      providerId="p1"
      providerName="My OpenAI"
    />,
  )
}

describe('ImportModelsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T-W12: marks imported / duplicate entries disabled with badges', () => {
    setup()
    renderDialog()

    expect(screen.getByText('已导入')).toBeDefined()
    expect(screen.getByText('已存在')).toBeDefined()

    expect(screen.getByRole('checkbox', { name: '选择 claude' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('checkbox', { name: '选择 taken-by-other' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('checkbox', { name: '选择 gpt-4o' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('T-W13: select-all only selects the currently filtered selectable entries', () => {
    setup()
    renderDialog()

    fireEvent.click(screen.getByRole('checkbox', { name: '全选可导入模型' }))
    expect(screen.getByText('已选 2 个')).toBeDefined()

    fireEvent.change(screen.getByLabelText('过滤模型'), { target: { value: 'gpt-4o' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '全选可导入模型' }))
    // 过滤后全选只影响当前结果：gpt-4o / gpt-4o-mini 被取消，claude 不可选
    expect(screen.getByText('已选 0 个')).toBeDefined()
  })

  it('T-W14: imports selected models and reports the created count', async () => {
    setup()
    mocks.importModels.mockResolvedValue({ data: { importGlobalModels: [{ id: 'm1' }, { id: 'm2' }] } })
    renderDialog()

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 gpt-4o' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 gpt-4o-mini' }))
    fireEvent.click(screen.getByRole('button', { name: /导入/ }))

    await waitFor(() =>
      expect(mocks.importModels).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { providerId: 'p1', names: expect.arrayContaining(['gpt-4o', 'gpt-4o-mini']) },
        }),
      ),
    )
    await waitFor(() => expect(screen.getByText('成功导入 2 个模型')).toBeDefined())
    expect(mocks.toastSuccess).toHaveBeenCalledWith('成功导入 2 个模型')
  })

  it('T-W15: shows the upstream error and lets the user retry', () => {
    setup({ error: new Error('供应商连通性测试失败，请检查 API 地址和凭据是否正确') })
    renderDialog()

    expect(screen.getByRole('alert').textContent).toContain('供应商连通性测试失败')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.refetch).toHaveBeenCalled()
  })

  it('shows the empty state when the upstream list is empty', () => {
    setup({ data: [] })
    renderDialog()
    expect(screen.getByText('暂无可导入的模型')).toBeDefined()
  })
})
