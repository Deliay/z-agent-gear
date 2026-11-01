import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import SidebarResizer from '../SidebarResizer'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  readSidebarWidth,
} from '@/lib/sidebar-width'

beforeEach(() => {
  localStorage.clear()
  document.body.className = ''
})

describe('clampSidebarWidth', () => {
  it('T-UI4-RES1 上下限 clamp（15–28rem）', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(9000)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(360)).toBe(360)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})

describe('SidebarResizer', () => {
  it('T-UI4-RES2 拖拽实时更新宽度并 clamp 在上下限内', () => {
    const onWidthChange = vi.fn()
    render(<SidebarResizer width={320} onWidthChange={onWidthChange} />)
    const handle = screen.getByTestId('sidebar-resizer')
    expect(handle.style.left).toBe('318px')

    fireEvent.pointerDown(handle, { clientX: 320 })
    fireEvent.pointerMove(window, { clientX: 380 })
    expect(onWidthChange).toHaveBeenCalledWith(380)

    fireEvent.pointerMove(window, { clientX: 5000 })
    expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_MAX_WIDTH)
  })

  it('T-UI4-RES3 pointerup 持久化宽度并移除 select-none', () => {
    const onWidthChange = vi.fn()
    render(<SidebarResizer width={320} onWidthChange={onWidthChange} />)
    const handle = screen.getByTestId('sidebar-resizer')

    fireEvent.pointerDown(handle, { clientX: 320 })
    expect(document.body.className).toContain('select-none')
    fireEvent.pointerMove(window, { clientX: 400 })
    fireEvent.pointerUp(window, { clientX: 400 })

    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('400')
    expect(document.body.className).not.toContain('select-none')
  })

  it('T-UI4-RES4 双击恢复默认宽度并持久化', () => {
    const onWidthChange = vi.fn()
    render(<SidebarResizer width={420} onWidthChange={onWidthChange} />)
    fireEvent.doubleClick(screen.getByTestId('sidebar-resizer'))
    expect(onWidthChange).toHaveBeenCalledWith(SIDEBAR_DEFAULT_WIDTH)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(SIDEBAR_DEFAULT_WIDTH))
  })

  it('T-UI4-RES5 readSidebarWidth 读取并 clamp 存量值，非法值回落默认', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '9999')
    expect(readSidebarWidth()).toBe(SIDEBAR_MAX_WIDTH)
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'abc')
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
    localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY)
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('热区为 4px 垂直分隔条（无障碍 role/aria）', () => {
    render(<SidebarResizer width={320} onWidthChange={vi.fn()} />)
    const handle = screen.getByRole('separator')
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle.className).toContain('w-1')
    expect(handle.className).toContain('cursor-col-resize')
  })
})
