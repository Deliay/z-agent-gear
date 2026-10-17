import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface DeleteWorkloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workloadName: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

export default function DeleteWorkloadDialog({
  open,
  onOpenChange,
  workloadName,
  onConfirm,
  loading = false,
}: DeleteWorkloadDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除工作负载</DialogTitle>
          <DialogDescription>
            确定要删除工作负载「{workloadName}」吗？此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={loading}
            onClick={() => {
              // 父组件负责错误提示；此处兜底吞掉未处理的 rejection
              Promise.resolve(onConfirm()).catch(() => {});
            }}
          >
            {loading ? '删除中...' : '删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
