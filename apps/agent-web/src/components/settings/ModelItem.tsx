import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVerticalIcon, Trash2Icon } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'

interface ModelData {
  id: string
  /** global（系统内置）模型由服务端掩蔽为 null */
  providerId: string | null
  provider?: {
    id: string
    name: string
    type: string
    isEnabled: boolean
  }
  name: string
  isCustom: boolean
  isEnabled: boolean
  sortOrder: number
  scope: 'user' | 'global'
}

interface ModelItemProps {
  model: ModelData
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  /** 是否渲染拖拽手柄（系统内置模型只读，不可拖拽） */
  sortable?: boolean
  /** 系统内置等场景不展示来源供应商 */
  hideProviderName?: boolean
  /** 只读开关（系统内置模型不可改） */
  readOnlyToggle?: boolean
}

export default function ModelItem({
  model,
  onToggle,
  onDelete,
  sortable = true,
  hideProviderName = false,
  readOnlyToggle = false,
}: ModelItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: model.id, disabled: !sortable })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const providerDisabled = model.provider && !model.provider.isEnabled
  const canToggle = !providerDisabled && !readOnlyToggle

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
        isDragging ? 'z-50 shadow-lg' : ''
      } ${model.isEnabled ? '' : 'opacity-60'}`}
    >
      {sortable && (
        <button
          className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
          aria-label="拖动排序"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-4" />
        </button>
      )}
      <div className="flex-1 min-w-0">
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
        {!hideProviderName && model.provider && (
          <p className="mt-0.5 text-xs text-muted-foreground">{model.provider.name}</p>
        )}
      </div>
      {model.isCustom && model.scope !== 'global' && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          onClick={() => {
            if (window.confirm(`确定要删除自定义模型「${model.name}」吗？`)) {
              onDelete(model.id)
            }
          }}
          title="删除自定义模型"
        >
          <Trash2Icon className="size-4" />
        </Button>
      )}
      <Switch
        checked={model.isEnabled}
        onCheckedChange={() => canToggle && onToggle(model.id)}
        disabled={!canToggle}
        title={readOnlyToggle ? '系统内置模型不可修改' : undefined}
        aria-label={`启用 ${model.name}`}
      />
    </div>
  )
}
