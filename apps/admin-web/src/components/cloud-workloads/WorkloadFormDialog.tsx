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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import type {
  CloudWorkloadData,
  CloudWorkloadInputData,
  CloudWorkloadParamFieldInputData,
} from '@/graphql/types';
import ParamSchemaEditor from './ParamSchemaEditor';
import { normalizeParamSchema, validateParamSchema } from '@/lib/workload-params';
import {
  detectDependencyCycle,
  MAX_WORKLOAD_DEPENDENCIES,
  type WorkloadPlanDefinition,
} from '@/lib/workload-plan';

interface WorkloadFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData?: CloudWorkloadData | null;
  onSave: (input: CloudWorkloadInputData) => Promise<void>;
  /** 依赖候选项（当前工作负载列表，用于多选与环检测） */
  dependencyCandidates?: CloudWorkloadData[];
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
  dependencyCandidates = [],
}: WorkloadFormDialogProps) {
  const [name, setName] = useState('');
  const [initScript, setInitScript] = useState('');
  const [postScript, setPostScript] = useState('');
  const [paramSchema, setParamSchema] = useState<CloudWorkloadParamFieldInputData[]>([]);
  const [dependsOnWorkloadIds, setDependsOnWorkloadIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setName(initialData?.name ?? '');
      setInitScript(initialData?.initScript ?? '');
      setPostScript(initialData?.postScript ?? '');
      setParamSchema(initialData?.paramSchema ?? []);
      setDependsOnWorkloadIds(initialData?.dependsOnWorkloadIds ?? []);
    }
  }, [open, initialData]);

  // 前端预校验（服务端仍强制）：名称 1~64 字符、至少一个脚本非空、单脚本 ≤16 KiB
  const trimmedName = name.trim();
  const nameTooLong = trimmedName.length > WORKLOAD_NAME_MAX_LENGTH;
  const hasScript = initScript.trim().length > 0 || postScript.trim().length > 0;
  const initScriptTooLarge = byteLength(initScript) > WORKLOAD_SCRIPT_MAX_BYTES;
  const postScriptTooLarge = byteLength(postScript) > WORKLOAD_SCRIPT_MAX_BYTES;
  const baseValid =
    trimmedName.length > 0 && !nameTooLong && hasScript && !initScriptTooLarge && !postScriptTooLarge;

  // 参数预校验：错误定位到具体参数（服务端仍强制）
  const paramErrors = validateParamSchema(paramSchema);

  // 依赖环检测（仅编辑已有工作负载时可能成环）
  const definitions: WorkloadPlanDefinition[] = dependencyCandidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    dependsOnWorkloadIds: candidate.dependsOnWorkloadIds ?? [],
  }));
  const cycle = detectDependencyCycle(
    initialData?.id ?? null,
    dependsOnWorkloadIds,
    definitions,
  );

  const isValid = baseValid && paramErrors.length === 0 && cycle === null;

  // 依赖候选项：排除自身；勾选顺序即初始化顺序
  const dependencyOptions = dependencyCandidates.filter(
    (candidate) => candidate.id !== initialData?.id,
  );
  const dependencyNameById = new Map(
    dependencyCandidates.map((candidate) => [candidate.id, candidate.name]),
  );
  const atDependencyLimit = dependsOnWorkloadIds.length >= MAX_WORKLOAD_DEPENDENCIES;

  const toggleDependency = (id: string, checked: boolean): void => {
    setDependsOnWorkloadIds((prev) => {
      if (checked) {
        if (prev.includes(id) || prev.length >= MAX_WORKLOAD_DEPENDENCIES) return prev;
        return [...prev, id];
      }
      return prev.filter((value) => value !== id);
    });
  };

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        initScript: initScript.trim() ? initScript : null,
        postScript: postScript.trim() ? postScript : null,
        paramSchema: normalizeParamSchema(paramSchema),
        dependsOnWorkloadIds,
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
      <DialogContent className="min-w-0 max-h-[85vh] overflow-y-auto sm:max-w-2xl">
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

          <div className="min-w-0 space-y-2 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">参数</p>
              <p className="text-xs text-muted-foreground">
                参数表单可以为空；每个参数必须有默认值。
              </p>
            </div>
            <ParamSchemaEditor value={paramSchema} onChange={setParamSchema} errors={paramErrors} />
          </div>

          <div className="min-w-0 space-y-2 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">依赖工作负载</p>
              <p className="text-xs text-muted-foreground">
                可选 0~{MAX_WORKLOAD_DEPENDENCIES} 个依赖，按勾选顺序初始化；不能依赖自身。
              </p>
            </div>
            {dependencyOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无可选依赖</p>
            ) : (
              <ScrollArea className="max-h-40 rounded-md border p-2">
                <ul className="space-y-1">
                  {dependencyOptions.map((candidate) => (
                    <li key={candidate.id} className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        aria-label={candidate.name}
                        checked={dependsOnWorkloadIds.includes(candidate.id)}
                        disabled={atDependencyLimit && !dependsOnWorkloadIds.includes(candidate.id)}
                        onCheckedChange={(checked) => toggleDependency(candidate.id, checked)}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {candidate.name}
                      </span>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
            <p className="text-xs text-muted-foreground">
              已选依赖（按初始化顺序）：
              {dependsOnWorkloadIds.length === 0
                ? '无'
                : dependsOnWorkloadIds
                    .map((id) => dependencyNameById.get(id) ?? id)
                    .join(' → ')}
            </p>
            {cycle && (
              <p role="alert" className="text-xs text-destructive">
                检测到依赖环：{cycle.join(' → ')} → {cycle[0]}，无法保存。
              </p>
            )}
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
          <Button onClick={handleSave} disabled={!isValid || saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
