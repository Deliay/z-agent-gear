import type { ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'

interface CollapsibleGroupProps {
  title: string
  count?: number
  expanded: boolean
  onToggle: () => void
  actions?: ReactNode
  children: ReactNode
}

/**
 * 轻量折叠组（手写，不引折叠库；与 admin-web 各自维护一份，禁止跨项目 import）。
 * 组头点击切换展开状态，`aria-expanded` 供无障碍与测试断言使用。
 */
export default function CollapsibleGroup({
  title,
  count,
  expanded,
  onToggle,
  actions,
  children,
}: CollapsibleGroupProps) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <ChevronDownIcon
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${
              expanded ? '' : '-rotate-90'
            }`}
          />
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {typeof count === 'number' && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {count}
            </span>
          )}
        </button>
        {actions}
      </div>
      {expanded && <div className="space-y-2 border-t p-3">{children}</div>}
    </div>
  )
}
