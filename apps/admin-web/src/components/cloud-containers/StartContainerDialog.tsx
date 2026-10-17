import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPopup,
  SelectItem,
  SelectItemText,
} from '@/components/ui/select';
import type { CloudContainerPurpose, CloudWorkloadData } from '@/graphql/types';
import { CONTAINER_PURPOSE_LABELS } from './labels';

// 本期仅提供 idle 任务（裁决 10 / PRD 3.4）
const PURPOSE_OPTIONS: CloudContainerPurpose[] = ['IDLE'];

interface StartContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workloads: CloudWorkloadData[];
  onStart: (purpose: CloudContainerPurpose, workloadIds: string[]) => Promise<void>;
}

export default function StartContainerDialog({
  open,
  onOpenChange,
  workloads,
  onStart,
}: StartContainerDialogProps) {
  const [purpose, setPurpose] = useState<CloudContainerPurpose>('IDLE');
  // 保持勾选顺序：数组顺序即提交顺序
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPurpose('IDLE');
      setSelectedIds([]);
      setError(null);
    }
  }, [open]);

  const toggleWorkload = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked) {
        return prev.includes(id) ? prev : [...prev, id];
      }
      return prev.filter((value) => value !== id);
    });
  };

  const handleConfirm = async () => {
    setStarting(true);
    setError(null);
    try {
      await onStart(purpose, selectedIds);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败，请重试');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>启动容器</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>任务类型</Label>
            <Select
              value={purpose}
              onValueChange={(value) => value && setPurpose(value as CloudContainerPurpose)}
            >
              <SelectTrigger aria-label="任务类型">
                <SelectValue>{CONTAINER_PURPOSE_LABELS[purpose]}</SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectPopup>
                {PURPOSE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    <SelectItemText>{CONTAINER_PURPOSE_LABELS[option]}</SelectItemText>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">本期仅支持 idle（空闲测试容器）。</p>
          </div>

          <div className="min-w-0 space-y-2">
            <Label>工作负载</Label>
            {workloads.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无可用工作负载</p>
            ) : (
              <ScrollArea className="max-h-48 rounded-md border p-2">
                <ul className="space-y-1">
                  {workloads.map((workload) => (
                    <li key={workload.id} className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        aria-label={workload.name}
                        checked={selectedIds.includes(workload.id)}
                        onCheckedChange={(checked) => toggleWorkload(workload.id, checked)}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {workload.name}
                      </span>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
            <p className="text-xs text-muted-foreground">可多选，按勾选顺序依次执行。</p>
          </div>
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={starting}>
            {starting ? '启动中...' : '确认启动'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
