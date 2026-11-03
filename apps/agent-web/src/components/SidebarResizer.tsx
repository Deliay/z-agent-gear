import { useEffect, useRef } from 'react'
import {
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
  persistSidebarWidth,
} from '@/lib/sidebar-width'

interface SidebarResizerProps {
  width: number
  onWidthChange: (width: number) => void
}

/**
 * 侧边栏与主内容区之间的 4px 拖拽热区：
 * pointer 拖拽实时调宽（clamp 15–28rem），pointerup 持久化到 localStorage，双击恢复默认 20rem。
 * 仅桌面端渲染（由 MainLayout 控制）。
 */
export default function SidebarResizer({ width, onWidthChange }: SidebarResizerProps) {
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    let latest = startWidth
    document.body.classList.add('select-none')

    const handleMove = (moveEvent: PointerEvent) => {
      latest = clampSidebarWidth(startWidth + moveEvent.clientX - startX)
      onWidthChange(latest)
    }
    const handleUp = () => {
      onWidthChange(latest)
      persistSidebarWidth(latest)
      document.body.classList.remove('select-none')
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      cleanupRef.current = null
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    cleanupRef.current = handleUp
  }

  const handleDoubleClick = () => {
    onWidthChange(SIDEBAR_DEFAULT_WIDTH)
    persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      title="拖拽调整宽度，双击恢复默认"
      data-testid="sidebar-resizer"
      className="absolute inset-y-0 z-20 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40 active:bg-primary/60"
      style={{ left: width - 2 }}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
    />
  )
}
