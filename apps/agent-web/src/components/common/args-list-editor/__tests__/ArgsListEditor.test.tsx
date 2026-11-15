import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ArgsListEditor from '../ArgsListEditor'

describe('ArgsListEditor（T-ALE）', () => {
  it('空态 + 添加/删除行', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ArgsListEditor value={[]} onChange={onChange} />)
    expect(screen.getByText('暂未声明参数')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '添加参数' }))
    expect(onChange).toHaveBeenCalledWith([{ key: '', name: '', description: '' }])

    rerender(
      <ArgsListEditor
        value={[{ key: 'city', name: '城市', description: '' }]}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '删除参数 1' }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('标识非法 / 重复 / 名称缺失即时提示', () => {
    render(
      <ArgsListEditor
        value={[
          { key: '1bad', name: '', description: '' },
          { key: 'city', name: '城市', description: '' },
          { key: 'city', name: '城市2', description: '' },
        ]}
        onChange={() => undefined}
      />,
    )
    expect(screen.getByText(/标识需以字母或下划线开头/)).toBeInTheDocument()
    expect(screen.getAllByText('参数标识重复')[0]).toBeInTheDocument()
    expect(screen.getByText('请输入参数名称')).toBeInTheDocument()
  })

  it('编辑行触发 onChange 且只改目标行', () => {
    const onChange = vi.fn()
    render(
      <ArgsListEditor
        value={[
          { key: 'a', name: 'A', description: '' },
          { key: 'b', name: 'B', description: '' },
        ]}
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByLabelText('参数标识 2'), { target: { value: 'b2' } })
    expect(onChange).toHaveBeenCalledWith([
      { key: 'a', name: 'A', description: '' },
      { key: 'b2', name: 'B', description: '' },
    ])
  })
})
