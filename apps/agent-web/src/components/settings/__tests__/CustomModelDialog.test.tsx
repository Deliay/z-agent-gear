import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import CustomModelDialog from '../CustomModelDialog'

const mocks = vi.hoisted(() => ({
  loadOptions: vi.fn(),
}))

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}))

vi.mock('@apollo/client/react', () => ({
  useLazyQuery: () => [mocks.loadOptions, { loading: false }],
}))

const PROVIDERS = [{ id: 'p1', name: 'My OpenAI' }]

function renderDialog(overrides: Partial<ComponentProps<typeof CustomModelDialog>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onOpenChange = vi.fn()
  render(
    <CustomModelDialog
      open
      onOpenChange={onOpenChange}
      providers={PROVIDERS}
      onSave={onSave}
      {...overrides}
    />,
  )
  return { onSave, onOpenChange }
}

function contextInput() {
  return screen.getByLabelText('最长上下文大小（token）')
}

describe('CustomModelDialog 上下文长度（T-MCWEB2）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadOptions.mockResolvedValue({ data: { providerModelOptions: [] } })
  })

  it('正整数校验文案与 admin-web 一致，非法输入不提交', () => {
    const { onSave } = renderDialog()

    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'gpt-4o' } })
    fireEvent.change(contextInput(), { target: { value: '0' } })

    expect(screen.getByText('请输入正整数')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.change(contextInput(), { target: { value: '1.5' } })
    expect(screen.getByText('请输入正整数')).toBeInTheDocument()
    expect(save).toBeDisabled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('留空提交 null', async () => {
    const { onSave } = renderDialog()

    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'gpt-4o' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('p1', 'gpt-4o', null),
    )
  })

  it('选定供应商 + 输入名称后按上游同名项预填上下文长度', async () => {
    mocks.loadOptions.mockResolvedValue({
      data: { providerModelOptions: [{ name: 'gpt-4o', contextLength: 128000 }] },
    })
    const { onSave } = renderDialog()

    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'gpt-4o' } })

    await waitFor(() => expect(contextInput()).toHaveValue('128000'), { timeout: 2000 })
    expect(mocks.loadOptions).toHaveBeenCalledWith({ variables: { providerId: 'p1' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('p1', 'gpt-4o', 128000))
  })

  it('用户已手改上下文时不覆盖', async () => {
    mocks.loadOptions.mockResolvedValue({
      data: { providerModelOptions: [{ name: 'gpt-4o', contextLength: 128000 }] },
    })
    renderDialog()

    fireEvent.change(contextInput(), { target: { value: '64000' } })
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'gpt-4o' } })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(contextInput()).toHaveValue('64000')
  })

  it('预填请求失败时静默忽略', async () => {
    mocks.loadOptions.mockRejectedValue(new Error('network error'))
    renderDialog()

    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'gpt-4o' } })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(contextInput()).toHaveValue('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('编辑模式：供应商与名称只读，仅可改上下文', async () => {
    const { onSave } = renderDialog({
      model: {
        id: 'm1',
        providerId: 'p1',
        provider: { name: 'My OpenAI' },
        name: 'model-m1',
        contextLength: 128000,
      },
    })

    expect(screen.getByText('编辑模型')).toBeInTheDocument()
    expect(screen.getByText('My OpenAI')).toBeInTheDocument()
    expect(screen.getByText('model-m1')).toBeInTheDocument()
    // 名称/供应商不是可输入控件
    expect(screen.queryByLabelText('模型名称')).toBeNull()
    expect(screen.queryByText('选择供应商')).toBeNull()

    expect(contextInput()).toHaveValue('128000')
    fireEvent.change(contextInput(), { target: { value: '200000' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('p1', 'model-m1', 200000))
  })

  it('编辑模式：清空上下文提交 null', async () => {
    const { onSave } = renderDialog({
      model: {
        id: 'm1',
        providerId: 'p1',
        provider: { name: 'My OpenAI' },
        name: 'model-m1',
        contextLength: 128000,
      },
    })

    fireEvent.change(contextInput(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('p1', 'model-m1', null))
  })
})
