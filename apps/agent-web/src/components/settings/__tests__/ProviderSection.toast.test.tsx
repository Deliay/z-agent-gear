import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ProviderSection from '../ProviderSection'
import { MODEL_CONFIG_APPLIED_NOTICE } from '@/lib/model-config-notice'
import { resetWorkspaceStore } from '@/stores/workspace'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  toggle: vi.fn(),
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
    if (source.includes('CreateProvider')) return [mocks.create, { loading: false }]
    if (source.includes('UpdateProvider')) return [mocks.update, { loading: false }]
    if (source.includes('ToggleProvider')) return [mocks.toggle, { loading: false }]
    if (source.includes('DeleteProvider')) return [mocks.remove, { loading: false }]
    return [vi.fn(), { loading: false }]
  },
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn() },
}))

vi.mock('@/stores/settingsOverview', () => ({
  useSettingsOverview: () => mocks.useQuery(),
}))

// 表单/行组件简化为可触发回调的按钮，聚焦 ProviderSection 的「保存成功提示」口径
vi.mock('../ProviderFormDialog', async () => {
  const React = await import('react')
  return {
    default: ({
      open,
      onSave,
    }: {
      open: boolean
      onSave: (input: {
        name: string
        type: string
        endpoint: string
        credentialType: string
        credentialValue: string
      }) => Promise<void>
    }) =>
      open
        ? React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => {
                void onSave({
                  name: 'My OpenAI',
                  type: 'openai',
                  endpoint: 'https://api.example',
                  credentialType: 'api_key',
                  credentialValue: 'sk-xxx',
                }).catch(() => {
                  // 失败路径由用例断言 toast 口径；此处吞掉未处理拒绝
                })
              },
            },
            '提交供应商表单',
          )
        : null,
  }
})

vi.mock('../ProviderItem', async () => {
  const React = await import('react')
  return {
    default: ({
      provider,
      onEdit,
      onToggle,
      onDelete,
    }: {
      provider: { id: string; name: string }
      onEdit: (provider: unknown) => void
      onToggle: (id: string) => void
      onDelete: (id: string) => void
    }) =>
      React.createElement(
        'div',
        null,
        React.createElement('span', null, provider.name),
        React.createElement('button', { type: 'button', onClick: () => onEdit(provider) }, '编辑供应商'),
        React.createElement('button', { type: 'button', onClick: () => onToggle(provider.id) }, '切换供应商'),
        React.createElement('button', { type: 'button', onClick: () => onDelete(provider.id) }, '删除供应商'),
      ),
  }
})

const PROVIDER = {
  id: 'p1',
  name: 'My OpenAI',
  type: 'openai',
  endpoint: 'https://api.example',
  credentialType: 'api_key',
  credentialValue: 'sk-xxx',
  isEnabled: true,
  scope: 'user' as const,
  workspaceId: null,
  models: [],
  createdAt: '',
  updatedAt: '',
}

function setup() {
  mocks.useQuery.mockReturnValue({ data: { providers: [PROVIDER] }, loading: false })
}

describe('ProviderSection 下发提醒（T-MCWEB3）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkspaceStore()
    mocks.create.mockResolvedValue({})
    mocks.update.mockResolvedValue({})
    mocks.toggle.mockResolvedValue({})
    mocks.remove.mockResolvedValue({})
    setup()
  })

  it('新增供应商成功后提示已下发（含 Harness 运行时提醒）', async () => {
    render(<ProviderSection />)

    fireEvent.click(screen.getByRole('button', { name: '添加供应商' }))
    fireEvent.click(screen.getByRole('button', { name: '提交供应商表单' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))
    expect(mocks.toastSuccess.mock.calls[0][0]).toBe(MODEL_CONFIG_APPLIED_NOTICE)
    expect(String(mocks.toastSuccess.mock.calls[0][0])).toContain(
      '部分 Harness 运行时不会重载模型配置',
    )
  })

  it('编辑供应商成功后同样提示', async () => {
    render(<ProviderSection />)

    fireEvent.click(screen.getByRole('button', { name: '编辑供应商' }))
    fireEvent.click(screen.getByRole('button', { name: '提交供应商表单' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))
    expect(mocks.toastSuccess.mock.calls[0][0]).toBe(MODEL_CONFIG_APPLIED_NOTICE)
  })

  it('保存失败不出现成功提示', async () => {
    mocks.create.mockRejectedValue(new Error('boom'))
    render(<ProviderSection />)

    fireEvent.click(screen.getByRole('button', { name: '添加供应商' }))
    fireEvent.click(screen.getByRole('button', { name: '提交供应商表单' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('启停与删除保持静默', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ProviderSection />)

    fireEvent.click(screen.getByRole('button', { name: '切换供应商' }))
    await waitFor(() => expect(mocks.toggle).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: '删除供应商' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalled())

    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})
