import { Button } from '@/components/ui/button'

interface BatchActionBarProps {
  selectedCount: number
  busy?: boolean
  onEnable: () => void
  onDisable: () => void
  onDelete: () => void
  onCancel: () => void
}

export default function BatchActionBar({
  selectedCount,
  busy = false,
  onEnable,
  onDisable,
  onDelete,
  onCancel,
}: BatchActionBarProps) {
  if (selectedCount === 0) return null

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-3">
      <span className="text-sm text-muted-foreground">
        已选 {selectedCount} 项
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onEnable} disabled={busy}>
          启用
        </Button>
        <Button size="sm" variant="secondary" onClick={onDisable} disabled={busy}>
          禁用
        </Button>
        <Button size="sm" variant="destructive" onClick={onDelete} disabled={busy}>
          删除
        </Button>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={onCancel}
        disabled={busy}
        className="ml-auto"
      >
        取消
      </Button>
    </div>
  )
}
