import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface DeleteWorkloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workloadName: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

/** 删除工作负载二次确认：统一走 `ConfirmDialog`（计划 §3.2 危险确认口径）。 */
export default function DeleteWorkloadDialog({
  open,
  onOpenChange,
  workloadName,
  onConfirm,
  loading = false,
}: DeleteWorkloadDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="删除工作负载"
      description={`确定要删除工作负载「${workloadName}」吗？此操作不可撤销。`}
      confirmLabel="删除"
      loadingLabel="删除中..."
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
