import * as React from "react"
import { cn } from "@/lib/utils"

interface PopoverContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  triggerRef: React.RefObject<HTMLElement | null>
}

const PopoverContext = React.createContext<PopoverContextValue>({
  open: false,
  setOpen: () => {},
  triggerRef: { current: null },
})

function Popover({
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}) {
  const [internalOpen, setInternalOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLElement | null>(null)

  const open = controlledOpen ?? internalOpen
  const setOpen = React.useCallback(
    (value: boolean) => {
      setInternalOpen(value)
      onOpenChange?.(value)
    },
    [onOpenChange]
  )

  return (
    <PopoverContext.Provider value={{ open, setOpen, triggerRef }}>
      <div className="relative">{children}</div>
    </PopoverContext.Provider>
  )
}

function PopoverTrigger({
  asChild,
  children,
}: {
  asChild?: boolean
  children: React.ReactNode
}) {
  const { open, setOpen, triggerRef } = React.useContext(PopoverContext)

  const handleClick = () => setOpen(!open)

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      ref: triggerRef,
      onClick: handleClick,
    })
  }

  return (
    <button ref={triggerRef as React.RefObject<HTMLButtonElement>} onClick={handleClick}>
      {children}
    </button>
  )
}

function PopoverContent({
  className,
  align = "center",
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  align?: "start" | "center" | "end"
}) {
  const { open, setOpen, triggerRef } = React.useContext(PopoverContext)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [position, setPosition] = React.useState<{ top: number; right?: number; left?: number }>({ top: 0 })

  React.useEffect(() => {
    if (!open) return

    const updatePosition = () => {
      if (triggerRef.current && contentRef.current) {
        const rect = triggerRef.current.getBoundingClientRect()
        const contentRect = contentRef.current.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        
        let top = rect.bottom + 4
        let left = rect.left
        let right: number | undefined
        
        // 如果底部空间不足，显示在上方
        if (top + contentRect.height > viewportHeight) {
          top = rect.top - contentRect.height - 4
        }
        
        // 确保不超出顶部
        if (top < 0) {
          top = 4
        }
        
        if (align === "end") {
          right = viewportWidth - rect.right
          // 确保不超出左侧
          if (right + contentRect.width > viewportWidth) {
            right = 4
          }
        } else {
          // 确保不超出右侧
          if (left + contentRect.width > viewportWidth) {
            left = viewportWidth - contentRect.width - 4
          }
          // 确保不超出左侧
          if (left < 0) {
            left = 4
          }
        }
        
        setPosition({
          top,
          ...(align === "end" ? { right } : { left }),
        })
      }
    }

    updatePosition()
    window.addEventListener("scroll", updatePosition, true)
    window.addEventListener("resize", updatePosition)

    return () => {
      window.removeEventListener("scroll", updatePosition, true)
      window.removeEventListener("resize", updatePosition)
    }
  }, [open, align, triggerRef])

  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (contentRef.current && !contentRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }

    document.addEventListener("mousedown", handleClickOutside)
    document.addEventListener("keydown", handleEscape)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [open, setOpen])

  if (!open) return null

  return (
    <div
      ref={contentRef}
      className={cn(
        "fixed z-50 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 shadow-lg",
        className
      )}
      style={position}
      {...props}
    >
      {children}
    </div>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
