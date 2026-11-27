import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../sheet'

function SheetHarness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        onOpenChange?.(next)
      }}
    >
      <SheetTrigger>打开收据</SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>收据详情</SheetTitle>
          <SheetDescription>完整计费维度拆解</SheetDescription>
        </SheetHeader>
        <div>
          <button type="button">抽屉内按钮</button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

describe('Sheet 原子组件', () => {
  it('T-AUI-SH1: 从右侧滑出渲染标题/内容，Esc 关闭且焦点圈定在抽屉内', async () => {
    const onOpenChange = vi.fn()
    render(<SheetHarness onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByRole('button', { name: '打开收据' }))
    expect(await screen.findByRole('heading', { name: '收据详情' })).toBeInTheDocument()
    expect(screen.getByText('完整计费维度拆解')).toBeInTheDocument()

    await waitFor(() => {
      const popup = document.querySelector('[data-slot="sheet-content"]')
      expect(popup).not.toBeNull()
      expect(popup?.contains(document.activeElement)).toBe(true)
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('T-AUI-SH2: 受控语义与 Dialog 同形，right 侧宽度档位存在', async () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>受控抽屉</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    )

    const popup = await screen.findByRole('dialog')
    expect(popup).toHaveAttribute('data-side', 'right')
    expect(popup.className).toContain('sm:max-w-[560px]')
    expect(popup.className).toContain('right-0')
  })
})
