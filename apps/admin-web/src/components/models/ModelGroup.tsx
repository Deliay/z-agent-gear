import type { ReactNode } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import CollapsibleGroup from '@/components/ui/collapsible-group'

interface ModelGroupProps {
  title: string
  count: number
  expanded: boolean
  onToggle: () => void
  itemIds: string[]
  children: ReactNode
}

/** 按供应商分组的模型列表：折叠组头 + 组内 SortableContext（跨组拖拽由父级忽略）。 */
export default function ModelGroup({
  title,
  count,
  expanded,
  onToggle,
  itemIds,
  children,
}: ModelGroupProps) {
  return (
    <CollapsibleGroup title={title} count={count} expanded={expanded} onToggle={onToggle}>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </CollapsibleGroup>
  )
}
