import type { ReactNode } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import CollapsibleGroup from '@/components/ui/collapsible-group'

interface ModelGroupProps {
  title: string
  count: number
  expanded: boolean
  onToggle: () => void
  /** 仅用户组可拖拽；系统内置组传 undefined 表示只读 */
  sortableIds?: string[]
  children: ReactNode
}

/** 可用模型分组：折叠组头 +（可选）组内 SortableContext。 */
export default function ModelGroup({
  title,
  count,
  expanded,
  onToggle,
  sortableIds,
  children,
}: ModelGroupProps) {
  return (
    <CollapsibleGroup title={title} count={count} expanded={expanded} onToggle={onToggle}>
      {sortableIds ? (
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
      ) : (
        children
      )}
    </CollapsibleGroup>
  )
}
