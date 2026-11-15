import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactElement } from 'react'

const mockUseQuery = vi.fn()
vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}))

import FragmentEditor from '../FragmentEditor'
import { GET_VALUT_MANUAL_OPTIONS } from '@/graphql/queries'

const params = { city: { name: '城市', description: '目标城市' } }

function renderEditor(ui: ReactElement) {
  return render(ui)
}

beforeEach(() => {
  mockUseQuery.mockReturnValue({ data: undefined, loading: false })
})

describe('FragmentEditor（T-FE2 / T-FE3）', () => {
  it('Plain 文本 + Valut/Parameter 原子 chip（不同 data-fragment-type 与格式角标）', () => {
    const { container } = renderEditor(
      <FragmentEditor
        value={[
          { type: 'Plain', value: 'https://x/', format: 'Generic' },
          { type: 'Parameter', value: 'city', format: 'Uri' },
          { type: 'Valut', value: 'TOKEN', format: 'Json' },
        ]}
        onChange={() => undefined}
        params={params}
      />,
    )
    const chips = container.querySelectorAll('[data-fragment-type]')
    expect(chips).toHaveLength(2)
    expect(chips[0].getAttribute('contenteditable')).toBe('false')
    expect(chips[0].textContent).toContain('$city')
    expect(chips[0].textContent).toContain('URI')
    expect(chips[1].getAttribute('contenteditable')).toBe('false')
    expect(chips[1].textContent).toContain('#TOKEN')
    expect(chips[1].textContent).toContain('JSON')
  })

  it('单行模式拦截 Enter；多行模式不拦截', () => {
    const { rerender } = renderEditor(
      <FragmentEditor mode="single" value={[]} onChange={() => undefined} ariaLabel="single" />,
    )
    const single = screen.getByRole('textbox', { name: 'single' })
    expect(fireEvent.keyDown(single, { key: 'Enter' })).toBe(false)

    rerender(<FragmentEditor mode="multi" value={[]} onChange={() => undefined} ariaLabel="multi" />)
    const multi = screen.getByRole('textbox', { name: 'multi' })
    expect(fireEvent.keyDown(multi, { key: 'Enter' })).toBe(true)
  })

  it('$ 打开参数补全（仅已声明参数），选择后可插入 chip', () => {
    const onChange = vi.fn()
    renderEditor(
      <FragmentEditor
        value={[{ type: 'Plain', value: 'hi ', format: 'Generic' }]}
        onChange={onChange}
        params={params}
        ariaLabel="prompt"
      />,
    )
    const editor = screen.getByRole('textbox', { name: 'prompt' })
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.keyDown(editor, { key: '$' })
    expect(screen.getByRole('listbox', { name: '参数' })).toBeInTheDocument()
    expect(screen.getByText('$city')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /城市/ }))
    expect(onChange).toHaveBeenCalled()
    const fragments = onChange.mock.calls.at(-1)?.[0]
    expect(fragments).toEqual([
      { type: 'Plain', value: 'hi ', format: 'Generic' },
      { type: 'Parameter', value: 'city', format: 'Generic' },
    ])
  })

  it('# 打开 Valut 补全时使用名单查询（不求值：查询不含 value 字段）', () => {
    renderEditor(
      <FragmentEditor value={[]} onChange={() => undefined} params={params} ariaLabel="prompt" />,
    )
    expect(mockUseQuery).toHaveBeenCalledWith(
      GET_VALUT_MANUAL_OPTIONS,
      expect.objectContaining({ skip: true }),
    )
    const editor = screen.getByRole('textbox', { name: 'prompt' })
    fireEvent.keyDown(editor, { key: '#' })
    expect(mockUseQuery).toHaveBeenLastCalledWith(
      GET_VALUT_MANUAL_OPTIONS,
      expect.objectContaining({ skip: false, fetchPolicy: 'cache-and-network' }),
    )
    const text = GET_VALUT_MANUAL_OPTIONS.loc?.source.body ?? ''
    expect(text).not.toContain('valueEncrypted')
    expect(text).not.toMatch(/\n\s*value\s*\n/)
  })
})
