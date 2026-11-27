import { ConfirmDialog } from '@/components/ui/confirm-dialog'

interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  onConfirm: () => void | Promise<void>
  loading?: boolean
}

/** 基础镜像删除二次确认：统一走 `ConfirmDialog`（计划 §3.2 危险确认口径）。 */
export default function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  loading = false,
}: DeleteConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel="删除"
      loadingLabel="删除中..."
      loading={loading}
      onConfirm={onConfirm}
    />
  )
}
