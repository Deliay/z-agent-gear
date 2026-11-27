import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface DestroyConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  containerName: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

/** 强制销毁容器二次确认：统一走 `ConfirmDialog`（计划 §3.2 危险确认口径）。 */
export default function DestroyConfirmDialog({
  open,
  onOpenChange,
  containerName,
  onConfirm,
  loading = false,
}: DestroyConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="强制销毁容器"
      description={`确定要强制销毁容器「${containerName}」吗？容器将退出且其 K8s Job 被删除。`}
      confirmLabel="强制销毁"
      loadingLabel="销毁中..."
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
