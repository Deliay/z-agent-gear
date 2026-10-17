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

/** 与服务端契约一致的校验上限（裁决 12）。 */
export const WORKLOAD_NAME_MAX_LENGTH = 64;
export const WORKLOAD_SCRIPT_MAX_BYTES = 16 * 1024;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

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

  // 前端预校验（服务端仍强制）：名称 1~64 字符、至少一个脚本非空、单脚本 ≤16 KiB
  const trimmedName = name.trim();
  const nameTooLong = trimmedName.length > WORKLOAD_NAME_MAX_LENGTH;
  const hasScript = initScript.trim().length > 0 || postScript.trim().length > 0;
  const initScriptTooLarge = byteLength(initScript) > WORKLOAD_SCRIPT_MAX_BYTES;
  const postScriptTooLarge = byteLength(postScript) > WORKLOAD_SCRIPT_MAX_BYTES;
  const isValid =
    trimmedName.length > 0 && !nameTooLong && hasScript && !initScriptTooLarge && !postScriptTooLarge;

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
              aria-invalid={nameTooLong}
            />
            {nameTooLong && (
              <p className="text-xs text-destructive">
                名称最多 {WORKLOAD_NAME_MAX_LENGTH} 个字符
              </p>
            )}
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
          <p className="text-xs text-muted-foreground">
            两个脚本至少填写一个；单个脚本不超过 16 KiB。
            {(initScriptTooLarge || postScriptTooLarge) && (
              <span className="text-destructive"> 脚本超过 16 KiB 上限。</span>
            )}
          </p>
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
