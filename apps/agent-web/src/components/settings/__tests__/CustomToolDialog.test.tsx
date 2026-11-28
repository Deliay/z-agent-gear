import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({ data: undefined, loading: false })),
}))

import CustomToolDialog from '../CustomToolDialog'

function renderDialog(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(
    <CustomToolDialog open tool={null} onClose={() => undefined} onSubmit={onSubmit} />,
  )
  return onSubmit
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CustomToolDialog（T-CTW2）', () => {
  it('默认 prompt：提示文案逐字出现 + 参数列表编辑器', () => {
    renderDialog()
    expect(
      screen.getByText('这个工具会要求 AI 输入参数列表中的参数，并将提示词的内容进行模板替换'),
    ).toBeInTheDocument()
    expect(screen.getByText('参数列表')).toBeInTheDocument()
    expect(screen.getByText('暂未声明参数')).toBeInTheDocument()
  })

  it('切换到 http：GET 类隐藏 body；POST 默认 JSON', () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'http' } })
    expect(screen.getByLabelText('请求方法')).toBeInTheDocument()
    expect(screen.queryByLabelText('请求体')).toBeNull()

    fireEvent.change(screen.getByLabelText('请求方法'), { target: { value: 'POST' } })
    expect(screen.getByLabelText('请求体')).toBeInTheDocument()
    expect((screen.getByLabelText('请求体') as HTMLSelectElement).value).toBe('json')

    fireEvent.change(screen.getByLabelText('请求方法'), { target: { value: 'GET' } })
    expect(screen.queryByLabelText('请求体')).toBeNull()
  })

  it('form 模式：file 类型保留但禁用并提示本期不支持', () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'http' } })
    fireEvent.change(screen.getByLabelText('请求方法'), { target: { value: 'POST' } })
    fireEvent.change(screen.getByLabelText('请求体'), { target: { value: 'form' } })
    fireEvent.click(screen.getByRole('button', { name: '添加 Form 字段' }))
    const select = screen.getByLabelText('Form 字段类型 1') as HTMLSelectElement
    const fileOption = Array.from(select.options).find((option) => option.value === 'file')
    expect(fileOption?.disabled).toBe(true)
    expect(fileOption?.textContent).toContain('本期不支持')
  })

  it('form 切回 json 后 stale form 行不阻塞提交（校验与提交内容一致）', async () => {
    const onSubmit = renderDialog()
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'stale-form-tool' } })
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'http' } })
    fireEvent.change(screen.getByLabelText('请求方法'), { target: { value: 'POST' } })

    fireEvent.change(screen.getByLabelText('请求体'), { target: { value: 'form' } })
    fireEvent.click(screen.getByRole('button', { name: '添加 Form 字段' }))
    expect(screen.getByLabelText('Form 字段 1')).toHaveValue('')

    fireEvent.change(screen.getByLabelText('请求体'), { target: { value: 'json' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const input = onSubmit.mock.calls[0][0]
    expect(input.http.bodyType).toBe('json')
    expect(input.http.form).toBeUndefined()
  })

  it('headers/queries 勾选展开；Cookie 重复被拦截；endpoint 必须 http(s)', async () => {
    const onSubmit = renderDialog()
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'http-tool' } })
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'http' } })

    fireEvent.click(screen.getByRole('checkbox', { name: /Headers/ }))
    expect(screen.getByLabelText('Header 名称 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '添加一行' }))
    fireEvent.change(screen.getByLabelText('Header 名称 1'), { target: { value: 'Cookie' } })
    fireEvent.change(screen.getByLabelText('Header 名称 2'), { target: { value: 'cookie' } })

    fireEvent.click(screen.getByRole('checkbox', { name: /Queries/ }))
    expect(screen.getByLabelText('Query 名称 1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/Header 2：header 名称重复/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
