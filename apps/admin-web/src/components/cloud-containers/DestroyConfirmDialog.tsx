import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface DestroyConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  containerName: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

export default function DestroyConfirmDialog({
  open,
  onOpenChange,
  containerName,
  onConfirm,
  loading = false,
}: DestroyConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>强制销毁容器</DialogTitle>
          <DialogDescription>
            确定要强制销毁容器「{containerName}」吗？容器将退出且其 K8s Job 被删除。
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
            {loading ? '销毁中...' : '强制销毁'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
