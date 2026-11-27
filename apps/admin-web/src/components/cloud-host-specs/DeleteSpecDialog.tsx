import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface DeleteSpecDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  specName: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

/** 删除容器规格二次确认：统一走 `ConfirmDialog`（计划 §3.2 危险确认口径）。 */
export default function DeleteSpecDialog({
  open,
  onOpenChange,
  specName,
  onConfirm,
  loading = false,
}: DeleteSpecDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="删除容器规格"
      description={`确定要删除规格「${specName}」吗？此操作不可撤销；已创建的云电脑不受影响（保持创建时的规格与计费）。`}
      confirmLabel="删除"
      loadingLabel="删除中..."
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
