import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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
  const hasData = Object.prototype.hasOwnProperty.call(overrides, 'data')
  mocks.useQuery.mockReturnValue({
    data: hasData
      ? { listGlobalProviderModels: overrides.data ?? [] }
      : overrides.error
        ? undefined
        : { listGlobalProviderModels: options },
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

  it('T-W16: keeps existing options and import feedback visible while refetching', () => {
    setup({ loading: true })
    renderDialog()

    expect(screen.queryByText('加载中...')).toBeNull()
    expect(screen.getByText('gpt-4o')).toBeDefined()
  })

  it('T-W17: refetches after a failed import so partially written models become visible', async () => {
    setup()
    mocks.refetch.mockResolvedValue(undefined)
    mocks.importModels.mockRejectedValue(new Error('Model name already exists: gpt-4o'))
    renderDialog()

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 gpt-4o' }))
    fireEvent.click(screen.getByRole('button', { name: /导入/ }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(mocks.refetch).toHaveBeenCalled()
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

  it('T-W18: does not report a successful import as failed when the follow-up refetch rejects (B-1)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setup()
    mocks.importModels.mockResolvedValue({ data: { importGlobalModels: [{ id: 'm1' }] } })
    mocks.refetch.mockRejectedValue(new Error('Variable "$providerId" of required type "ID!" was not provided.'))
    renderDialog()

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 gpt-4o' }))
    fireEvent.click(screen.getByRole('button', { name: /导入/ }))

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('成功导入 1 个模型'))
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(screen.getByText('成功导入 1 个模型')).toBeDefined()
    // 导入后本地立即标记已导入并禁选
    expect(screen.getByRole('checkbox', { name: '选择 gpt-4o' })).toHaveAttribute('aria-disabled', 'true')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('T-W19: closing while the import is in flight does not refetch, and reopening trusts server results (B-2)', async () => {
    setup()
    let resolveImport: (value: unknown) => void = () => {}
    mocks.importModels.mockImplementation(
      () => new Promise((resolve) => {
        resolveImport = resolve
      }),
    )
    const { rerender } = renderDialog()

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 gpt-4o' }))
    fireEvent.click(screen.getByRole('button', { name: /导入/ }))

    // 关闭弹窗：ProviderSection 会把 importTarget 置 null，providerId 随之变为 null
    rerender(
      <ImportModelsDialog open={false} onOpenChange={() => {}} providerId={null} providerName="" />,
    )
    await act(async () => {
      resolveImport({ data: { importGlobalModels: [{ id: 'm1' }] } })
    })

    expect(mocks.toastSuccess).toHaveBeenCalledWith('成功导入 1 个模型')
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.refetch).not.toHaveBeenCalled()

    // 重新打开：以服务端结果为准（gpt-4o 已导入、禁选），勾选清零
    setup({ data: [
      { name: 'gpt-4o', isImported: true, isDuplicate: false },
      { name: 'gpt-4o-mini', isImported: false, isDuplicate: false },
    ] })
    rerender(
      <ImportModelsDialog open onOpenChange={() => {}} providerId="p1" providerName="My OpenAI" />,
    )

    expect(screen.getByText('已选 0 个')).toBeDefined()
    expect(screen.getByRole('checkbox', { name: '选择 gpt-4o' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('已导入')).toBeDefined()
  })

  it('T-W20: ignores a rapid double click before the importing state renders (C-12)', async () => {
    setup()
    let resolveImport: (value: unknown) => void = () => {}
    mocks.importModels.mockImplementation(
      () => new Promise((resolve) => {
        resolveImport = resolve
      }),
    )
    renderDialog()

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 gpt-4o' }))
    const importButton = screen.getByRole('button', { name: /导入/ })
    fireEvent.click(importButton)
    fireEvent.click(importButton)

    expect(mocks.importModels).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveImport({ data: { importGlobalModels: [] } })
    })
  })

  it('T-W21: keeps the import button usable when a background refetch fails after data has loaded (C-2)', () => {
    mocks.useQuery.mockReturnValue({
      data: { listGlobalProviderModels: options },
      loading: false,
      error: new Error('refetch failed'),
      refetch: mocks.refetch,
    })
    renderDialog()

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 gpt-4o' }))
    expect(screen.getByRole('button', { name: /导入/ })).not.toBeDisabled()
  })

  it('T-W22: keeps the failure detail in the dialog instead of only a transient toast (C-3)', async () => {
    setup()
    mocks.refetch.mockResolvedValue(undefined)
    mocks.importModels.mockRejectedValue(new Error('Model name already exists: gpt-4o'))
    renderDialog()

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 gpt-4o' }))
    fireEvent.click(screen.getByRole('button', { name: /导入/ }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('导入失败：Model name already exists: gpt-4o'),
    )
  })
})
