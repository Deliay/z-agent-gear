import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../sheet'

function renderSheet(open: boolean, onOpenChange = vi.fn()) {
  render(
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>节点详情</SheetTitle>
          <SheetDescription>详情描述</SheetDescription>
        </SheetHeader>
        <div>抽屉内容</div>
      </SheetContent>
    </Sheet>,
  )
  return { onOpenChange }
}

describe('Sheet', () => {
  it('T-UI4-SH1 打开时渲染标题与内容', () => {
    renderSheet(true)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('节点详情')).toBeInTheDocument()
    expect(screen.getByText('抽屉内容')).toBeInTheDocument()
  })

  it('T-UI4-SH2 关闭时不渲染内容', () => {
    renderSheet(false)
    expect(screen.queryByText('抽屉内容')).not.toBeInTheDocument()
  })

  it('T-UI4-SH3 点击关闭按钮触发 onOpenChange(false)', () => {
    const { onOpenChange } = renderSheet(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
  })

  it('T-UI4-SH4 抽屉根为右侧全高定位类名', () => {
    renderSheet(true)
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('right-0')
    expect(dialog.className).toContain('inset-y-0')
    expect(dialog.className).toContain('h-full')
  })
})
