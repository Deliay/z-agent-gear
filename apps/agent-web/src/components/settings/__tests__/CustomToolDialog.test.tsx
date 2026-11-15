import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

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
    expect(screen.getByLabelText('Method')).toBeInTheDocument()
    expect(screen.queryByLabelText('Body')).toBeNull()

    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'POST' } })
    expect(screen.getByLabelText('Body')).toBeInTheDocument()
    expect((screen.getByLabelText('Body') as HTMLSelectElement).value).toBe('json')

    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'GET' } })
    expect(screen.queryByLabelText('Body')).toBeNull()
  })

  it('form 模式：file 类型保留但禁用并提示本期不支持', () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'http' } })
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'POST' } })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'form' } })
    fireEvent.click(screen.getByRole('button', { name: '添加 Form 字段' }))
    const select = screen.getByLabelText('Form 字段类型 1') as HTMLSelectElement
    const fileOption = Array.from(select.options).find((option) => option.value === 'file')
    expect(fileOption?.disabled).toBe(true)
    expect(fileOption?.textContent).toContain('本期不支持')
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
