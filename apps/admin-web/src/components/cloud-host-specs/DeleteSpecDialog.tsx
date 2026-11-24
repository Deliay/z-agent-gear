import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface DeleteSpecDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  specName: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

export default function DeleteSpecDialog({
  open,
  onOpenChange,
  specName,
  onConfirm,
  loading = false,
}: DeleteSpecDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除容器规格</DialogTitle>
          <DialogDescription>
            确定要删除规格「{specName}」吗？此操作不可撤销；已创建的云电脑不受影响（保持创建时的规格与计费）。
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
