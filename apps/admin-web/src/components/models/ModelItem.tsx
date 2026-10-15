import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVerticalIcon, Trash2Icon } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import type { AdminModelData } from '@/graphql/types'

interface ModelItemProps {
  model: AdminModelData
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  togglePending?: boolean
}

export default function ModelItem({ model, onToggle, onDelete, togglePending = false }: ModelItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: model.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const providerDisabled = model.provider && !model.provider.isEnabled
  const canToggle = !providerDisabled

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
        isDragging ? 'z-50 shadow-lg' : ''
      } ${model.isEnabled ? '' : 'opacity-60'}`}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label="拖动排序"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{model.name}</span>
          {model.isCustom && (
            <span className="rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground">
              自定义
            </span>
          )}
          {!model.isEnabled && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              已禁用
            </span>
          )}
          {providerDisabled && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              供应商已禁用
            </span>
          )}
        </div>
        {model.provider && (
          <p className="mt-0.5 text-xs text-muted-foreground">{model.provider.name}</p>
        )}
      </div>
      {model.isCustom && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(model.id)}
          title="删除自定义模型"
        >
          <Trash2Icon className="size-4" />
        </Button>
      )}
      <Switch
        checked={model.isEnabled && canToggle}
        onCheckedChange={() => {
          if (canToggle && !togglePending) onToggle(model.id)
        }}
        disabled={!canToggle || togglePending}
        aria-label={`启用 ${model.name}`}
      />
    </div>
  )
}
