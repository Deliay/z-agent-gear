import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import HarnessConfigsPage from '../HarnessConfigsPage'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  mutations: [] as Array<{ fn: ReturnType<typeof vi.fn>; options: unknown }>,
  /** 每次渲染都会重新构造 mutation fn，失败场景用该 impl 让所有实例共享同一行为。 */
  mutationImpl: undefined as undefined | (() => Promise<unknown>),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@apollo/client', () => ({ gql: vi.fn(() => '') }))
vi.mock('@apollo/client/react', () => ({
  useQuery: mocks.useQuery,
  useMutation: vi.fn((_doc: unknown, options?: unknown) => {
    const fn = vi.fn(() =>
      mocks.mutationImpl ? mocks.mutationImpl() : Promise.resolve({ data: {} }),
    )
    mocks.mutations.push({ fn, options })
    return [fn, { loading: false }]
  }),
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, message: vi.fn() },
}))

interface ConfigRow {
  harnessType: string
  compactCommand: string
  updatedAt: string
}

interface MutationArgs {
  variables?: { harnessType?: string; compactCommand?: string }
  refetchQueries?: unknown[]
}

const UPDATED_AT = '2026-11-15T08:00:00.000Z'

function mockQuery(configs?: ConfigRow[], overrides: Partial<{ loading: boolean; error?: Error }> = {}) {
  mocks.useQuery.mockReturnValue({
    data: configs ? { adminHarnessConfigs: configs } : undefined,
    loading: overrides.loading ?? false,
    error: overrides.error,
    refetch: vi.fn(),
  })
}

function mutationCall(predicate: (args: MutationArgs) => boolean) {
  const entry = mocks.mutations.find(({ fn }) =>
    fn.mock.calls.some((call) => predicate(call[0] as MutationArgs)),
  )
  return entry ? (entry.fn.mock.calls[0][0] as MutationArgs) : undefined
}

describe('HarnessConfigsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutations.length = 0
    mocks.mutationImpl = undefined
  })

  // T-HC-WEB1：三行 Harness 展示与默认 /compact 回显（含库内自定义值回显）、加载分支
  it('T-HC-WEB1 固定渲染三行 Harness，缺失行回显默认 /compact，库内值原样回显', () => {
    mockQuery([
      { harnessType: 'OPENCODE', compactCommand: '/compact', updatedAt: UPDATED_AT },
      { harnessType: 'DEEPSEEK_HARNESS', compactCommand: '/ctx-compact', updatedAt: UPDATED_AT },
    ])
    render(<HarnessConfigsPage />)

    expect(screen.getByText('OpenCode')).toBeDefined()
    expect(screen.getByText('Kimi Code')).toBeDefined()
    expect(screen.getByText('DeepSeek Harness')).toBeDefined()

    const opencode = screen.getByLabelText('OpenCode 压缩指令') as HTMLInputElement
    const kimi = screen.getByLabelText('Kimi Code 压缩指令') as HTMLInputElement
    const deepseek = screen.getByLabelText('DeepSeek Harness 压缩指令') as HTMLInputElement

    expect(opencode.value).toBe('/compact')
    expect(kimi.value).toBe('/compact')
    expect(deepseek.value).toBe('/ctx-compact')

    expect(screen.getAllByRole('button', { name: /^保存 / })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: /^保存 / }).every((btn) => btn.hasAttribute('disabled'))).toBe(false)
  })

  it('T-HC-WEB1 首次加载分支为 loading && !data', () => {
    mockQuery(undefined, { loading: true })
    render(<HarnessConfigsPage />)

    expect(screen.getByText('加载中...')).toBeDefined()
    expect(screen.queryByLabelText('OpenCode 压缩指令')).toBeNull()
  })

  it('T-HC-WEB1 首次加载失败展示错误态并可重试', () => {
    mockQuery(undefined, { error: new Error('boom') })
    render(<HarnessConfigsPage />)

    expect(screen.getByText('数据加载失败')).toBeDefined()
    expect(screen.getByText('boom')).toBeDefined()
    expect(screen.getByRole('button', { name: '重试' })).toBeDefined()
  })

  // T-HC-WEB2：逐行保存调用 UPSERT_HARNESS_CONFIG（变量逐字段对齐）+ 成功 refetch
  it('T-HC-WEB2 逐行保存提交 harnessType/compactCommand 并 refetch', async () => {
    mockQuery([
      { harnessType: 'OPENCODE', compactCommand: '/compact', updatedAt: UPDATED_AT },
      { harnessType: 'KIMI_CODE', compactCommand: '/compact', updatedAt: UPDATED_AT },
      { harnessType: 'DEEPSEEK_HARNESS', compactCommand: '/compact', updatedAt: UPDATED_AT },
    ])
    render(<HarnessConfigsPage />)

    fireEvent.change(screen.getByLabelText('Kimi Code 压缩指令'), { target: { value: '  /summarize  ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Kimi Code' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Kimi Code 压缩指令')).toHaveValue('/summarize')
    })

    const call = mutationCall((args) => args.variables?.harnessType === 'KIMI_CODE')
    expect(call).toBeDefined()
    expect(call!.variables).toEqual({ harnessType: 'KIMI_CODE', compactCommand: '/summarize' })
    expect(call!.refetchQueries).toHaveLength(1)
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
    // 逐行保存：只提交当前行
    expect(mocks.mutations.every(({ fn }) => fn.mock.calls.length <= 1)).toBe(true)
    expect(mocks.mutations.filter(({ fn }) => fn.mock.calls.length > 0)).toHaveLength(1)
  })

  it('T-HC-WEB2 非法输入禁用保存并给出提示', () => {
    mockQuery([
      { harnessType: 'OPENCODE', compactCommand: '/compact', updatedAt: UPDATED_AT },
    ])
    render(<HarnessConfigsPage />)

    const input = screen.getByLabelText('OpenCode 压缩指令')
    const save = screen.getByRole('button', { name: '保存 OpenCode' })

    // 空值
    fireEvent.change(input, { target: { value: '' } })
    expect(save).toBeDisabled()
    expect(screen.getByText('指令需以 / 开头且长度 1~64')).toBeDefined()

    // 不以 / 开头
    fireEvent.change(input, { target: { value: 'compact' } })
    expect(save).toBeDisabled()
    expect(screen.getByText('指令需以 / 开头且长度 1~64')).toBeDefined()

    // 超 64 字符
    fireEvent.change(input, { target: { value: `/${'a'.repeat(64)}` } })
    expect(save).toBeDisabled()

    // 合法后恢复可用且提示消失
    fireEvent.change(input, { target: { value: '/compact' } })
    expect(save).not.toBeDisabled()
    expect(screen.queryByText('指令需以 / 开头且长度 1~64')).toBeNull()
  })

  it('T-HC-WEB2 服务端 invalid compact command 映射为中文提示', async () => {
    mockQuery([
      { harnessType: 'OPENCODE', compactCommand: '/compact', updatedAt: UPDATED_AT },
    ])
    render(<HarnessConfigsPage />)

    mocks.mutationImpl = () => Promise.reject(new Error('invalid compact command'))
    fireEvent.change(screen.getByLabelText('OpenCode 压缩指令'), { target: { value: '/ctx' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenCode' }))

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('指令需以 / 开头且长度 1~64')
    })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('T-HC-WEB2 其他服务端错误原样透出', async () => {
    mockQuery([
      { harnessType: 'OPENCODE', compactCommand: '/compact', updatedAt: UPDATED_AT },
    ])
    render(<HarnessConfigsPage />)

    mocks.mutationImpl = () => Promise.reject(new Error('Not authenticated'))
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenCode' }))

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('Not authenticated')
    })
  })
})
