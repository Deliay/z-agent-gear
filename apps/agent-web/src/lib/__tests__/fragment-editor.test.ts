import { describe, it, expect } from 'vitest'
import {
  describeFragments,
  formatForEditorMode,
  fragmentsToNodes,
  nodesToFragments,
  refDisplay,
  type Fragment,
} from '../fragment-editor'

const fixture: Fragment[] = [
  { type: 'Plain', value: 'https://foo.bar/', format: 'Generic' },
  { type: 'Parameter', value: 'city', format: 'Uri' },
  { type: 'Plain', value: '/weather/', format: 'Generic' },
  { type: 'Valut', value: 'TOKEN', format: 'Generic' },
  { type: 'Plain', value: '', format: 'Generic' },
]

describe('lib/fragment-editor（T-FE1，与后端契约互锁）', () => {
  it('round-trip：相邻 Plain 合并、空 Plain 省略', () => {
    const nodes = fragmentsToNodes(fixture)
    expect(nodes).toEqual([
      { kind: 'text', text: 'https://foo.bar/' },
      { kind: 'ref', type: 'Parameter', value: 'city', format: 'Uri' },
      { kind: 'text', text: '/weather/' },
      { kind: 'ref', type: 'Valut', value: 'TOKEN', format: 'Generic' },
    ])

    const back = nodesToFragments(nodes)
    expect(back).toEqual([
      { type: 'Plain', value: 'https://foo.bar/', format: 'Generic' },
      { type: 'Parameter', value: 'city', format: 'Uri' },
      { type: 'Plain', value: '/weather/', format: 'Generic' },
      { type: 'Valut', value: 'TOKEN', format: 'Generic' },
    ])
    // 归一后幂等
    expect(nodesToFragments(fragmentsToNodes(back))).toEqual(back)
  })

  it('相邻 Plain 合并为单个片段；纯引用模板无 Plain', () => {
    expect(
      nodesToFragments([
        { kind: 'text', text: 'a' },
        { kind: 'text', text: 'b' },
        { kind: 'ref', type: 'Valut', value: 'K', format: 'Json' },
      ]),
    ).toEqual([
      { type: 'Plain', value: 'ab', format: 'Generic' },
      { type: 'Valut', value: 'K', format: 'Json' },
    ])

    expect(
      nodesToFragments([{ kind: 'text', text: '' }, { kind: 'ref', type: 'Parameter', value: 'x', format: 'Generic' }]),
    ).toEqual([{ type: 'Parameter', value: 'x', format: 'Generic' }])
  })

  it('编辑器模式 → 引用格式；chip 展示名称（不求值）', () => {
    expect(formatForEditorMode('Generic')).toBe('Generic')
    expect(formatForEditorMode('Json')).toBe('Json')
    expect(formatForEditorMode('Uri')).toBe('Uri')
    expect(refDisplay('Valut', 'API_TOKEN')).toBe('#API_TOKEN')
    expect(refDisplay('Parameter', 'city')).toBe('$city')
    expect(describeFragments(fixture)).toBe('https://foo.bar/$city/weather/#TOKEN')
  })

  it('与后端 fragment-render fixture 同源：Plain 恒 Generic（序列化不产生非 Generic 的 Plain）', () => {
    const fragments = nodesToFragments(fragmentsToNodes(fixture))
    for (const fragment of fragments.filter((item) => item.type === 'Plain')) {
      expect(fragment.format).toBe('Generic')
    }
  })
})
