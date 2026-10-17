import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CloudWorkloadData, CloudWorkloadInputData } from '@/graphql/types';

interface WorkloadFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData?: CloudWorkloadData | null;
  onSave: (input: CloudWorkloadInputData) => Promise<void>;
}

const SCRIPT_PLACEHOLDER = '# 例如：\ngit clone <repo> /workspace\nnpm install';

export default function WorkloadFormDialog({
  open,
  onOpenChange,
  initialData,
  onSave,
}: WorkloadFormDialogProps) {
  const [name, setName] = useState('');
  const [initScript, setInitScript] = useState('');
  const [postScript, setPostScript] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setName(initialData?.name ?? '');
      setInitScript(initialData?.initScript ?? '');
      setPostScript(initialData?.postScript ?? '');
    }
  }, [open, initialData]);

  // 至少一个脚本（trim 后）非空，且名称必填
  const isValid = name.trim().length > 0 && (initScript.trim().length > 0 || postScript.trim().length > 0);

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        initScript: initScript.trim() ? initScript : null,
        postScript: postScript.trim() ? postScript : null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initialData ? '编辑工作负载' : '新建工作负载'}</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="workload-name">名称</Label>
            <Input
              id="workload-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: node-env-setup"
            />
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="workload-init-script">初始化脚本</Label>
            <textarea
              id="workload-init-script"
              value={initScript}
              onChange={(e) => setInitScript(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={SCRIPT_PLACEHOLDER}
              className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm whitespace-pre-wrap break-all outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="workload-post-script">清理脚本</Label>
            <textarea
              id="workload-post-script"
              value={postScript}
              onChange={(e) => setPostScript(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={SCRIPT_PLACEHOLDER}
              className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm whitespace-pre-wrap break-all outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          <p className="text-xs text-muted-foreground">两个脚本至少填写一个。</p>
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
          <Button onClick={handleSave} disabled={!isValid || saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
