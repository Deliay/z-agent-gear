import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ResourceChip, { ResourceChips } from '../ResourceChip'
import type { GraphResource } from '../graph-layout'

function resource(overrides: Partial<GraphResource> = {}): GraphResource {
  return {
    id: 'r1',
    kind: 'blackboard',
    title: '评审报告',
    value: '内容',
    url: null,
    checkRunUrl: null,
    pullRequestId: null,
    nodeId: 'n1',
    ...overrides,
  }
}

describe('ResourceChip', () => {
  it('T-UI4-RC1 三类资源渲染对应图标与标题', () => {
    const { rerender } = render(<ResourceChip resource={resource()} />)
    expect(screen.getByText('评审报告')).toBeInTheDocument()
    expect(screen.getByTestId('resource-chip-blackboard')).toBeInTheDocument()

    rerender(<ResourceChip resource={resource({ kind: 'pr', title: 'acme/repo#1', url: 'https://x' })} />)
    expect(screen.getByTestId('resource-chip-pr')).toBeInTheDocument()

    rerender(<ResourceChip resource={resource({ kind: 'prompt', title: 'review' })} />)
    expect(screen.getByTestId('resource-chip-prompt')).toBeInTheDocument()
  })

  it('T-UI4-RC2 限宽 12rem 且标题最多 2 行截断', () => {
    render(<ResourceChip resource={resource({ title: '很长的资源标题'.repeat(10) })} />)
    const chip = screen.getByTestId('resource-chip-blackboard')
    expect(chip.className).toContain('max-w-48')
    expect(chip.querySelector('.line-clamp-2')).toBeTruthy()
  })

  it('T-UI4-RC3 点击回调资源对象且阻止冒泡', () => {
    const onOpen = vi.fn()
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <ResourceChip resource={resource()} onOpen={onOpen} />
      </div>,
    )
    fireEvent.click(screen.getByTestId('resource-chip-blackboard'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('T-UI4-RC4 超过 3 个资源时折叠为「+N」入口', () => {
    const onOpenMore = vi.fn()
    render(
      <ResourceChips
        resources={[resource({ id: 'a' }), resource({ id: 'b' }), resource({ id: 'c' })]}
        moreResources={2}
        onOpenMore={onOpenMore}
      />,
    )
    fireEvent.click(screen.getByText('2'))
    expect(onOpenMore).toHaveBeenCalledTimes(1)
  })

  it('T-UI4-RC5 实例资源行横排换行', () => {
    render(<ResourceChips resources={[resource()]} wrap />)
    expect(screen.getByTestId('resource-row').className).toContain('flex-wrap')
  })

  it('T-UI4-RC6 无资源时不渲染（垃圾桶资源不会进入视图模型）', () => {
    const { container } = render(<ResourceChips resources={[]} moreResources={0} />)
    expect(container).toBeEmptyDOMElement()
  })
})
