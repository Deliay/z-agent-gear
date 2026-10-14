import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPopup,
  SelectItem,
  SelectItemText,
} from '@/components/ui/select';
import type { CloudContainerPurpose } from '@/graphql/types';
import { CONTAINER_PURPOSE_LABELS } from './labels';

// 本期仅提供 idle 任务（裁决 10 / PRD 3.4）
const PURPOSE_OPTIONS: CloudContainerPurpose[] = ['IDLE'];

interface StartContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (purpose: CloudContainerPurpose) => Promise<void>;
}

export default function StartContainerDialog({
  open,
  onOpenChange,
  onStart,
}: StartContainerDialogProps) {
  const [purpose, setPurpose] = useState<CloudContainerPurpose>('IDLE');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPurpose('IDLE');
      setError(null);
    }
  }, [open]);

  const handleConfirm = async () => {
    setStarting(true);
    setError(null);
    try {
      await onStart(purpose);
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
