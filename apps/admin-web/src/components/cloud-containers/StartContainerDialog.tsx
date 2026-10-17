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
import type {
  CloudContainerPurpose,
  CloudWorkloadData,
  CloudWorkloadSelectionData,
} from '@/graphql/types';
import { CONTAINER_PURPOSE_LABELS } from './labels';
import WorkloadParamsForm from './WorkloadParamsForm';
import {
  buildDefaultParams,
  validateParamValues,
  type ParamValueError,
  type WorkloadParamValues,
} from '@/lib/workload-params';
import { MAX_PLAN_ITEMS, previewWorkloadPlan, type WorkloadPlanDefinition } from '@/lib/workload-plan';

// 本期仅提供 idle 任务（裁决 10 / PRD 3.4）
const PURPOSE_OPTIONS: CloudContainerPurpose[] = ['IDLE'];

interface StartContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workloads: CloudWorkloadData[];
  onStart: (purpose: CloudContainerPurpose, workloads: CloudWorkloadSelectionData[]) => Promise<void>;
  /** 工作负载列表是否处于首次加载中（`loading && !data`）。 */
  workloadsLoading?: boolean;
  /** 工作负载列表首次加载失败的文案（有缓存数据时不透传，避免误导）。 */
  workloadsError?: string | null;
  /** 重试加载工作负载列表。 */
  onRetryWorkloads?: () => void;
}

/** 单次启动可显式勾选的工作负载上限（契约裁决 12）。 */
export const MAX_WORKLOADS_PER_START = 10;

export default function StartContainerDialog({
  open,
  onOpenChange,
  workloads,
  onStart,
  workloadsLoading = false,
  workloadsError = null,
  onRetryWorkloads,
}: StartContainerDialogProps) {
  const [purpose, setPurpose] = useState<CloudContainerPurpose>('IDLE');
  // 保持勾选顺序：数组顺序即提交顺序
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [paramsByWorkload, setParamsByWorkload] = useState<Record<string, WorkloadParamValues>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPurpose('IDLE');
      setSelectedIds([]);
      setParamsByWorkload({});
      setError(null);
    }
  }, [open]);

  const workloadById = new Map(workloads.map((workload) => [workload.id, workload]));
  const selectedWorkloads = selectedIds
    .map((id) => workloadById.get(id))
    .filter((workload): workload is CloudWorkloadData => Boolean(workload));

  const definitions: WorkloadPlanDefinition[] = workloads.map((workload) => ({
    id: workload.id,
    name: workload.name,
    dependsOnWorkloadIds: workload.dependsOnWorkloadIds ?? [],
  }));
  // 顺序预览与隐式依赖（前端镜像，最终以服务端计划为准）
  const preview = previewWorkloadPlan(selectedIds, definitions);
  const overLimit = preview.items.length > MAX_PLAN_ITEMS;

  const toggleWorkload = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked) {
        if (prev.includes(id)) return prev;
        // 契约上限：最多挂载 10 个（超限由服务端 400，前端先行拦截）
        if (prev.length >= MAX_WORKLOADS_PER_START) return prev;
        return [...prev, id];
      }
      return prev.filter((value) => value !== id);
    });
    setParamsByWorkload((prev) => {
      if (checked) {
        const workload = workloadById.get(id);
        return { ...prev, [id]: buildDefaultParams(workload?.paramSchema ?? []) };
      }
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const atLimit = selectedIds.length >= MAX_WORKLOADS_PER_START;

  // 参数预校验：按工作负载定位（服务端仍强制）
  const paramErrorsByWorkload: Record<string, ParamValueError[]> = {};
  for (const workload of selectedWorkloads) {
    const errors = validateParamValues(workload.paramSchema ?? [], paramsByWorkload[workload.id] ?? {});
    if (errors.length > 0) paramErrorsByWorkload[workload.id] = errors;
  }
  const hasParamErrors = Object.keys(paramErrorsByWorkload).length > 0;
  const canStart = !overLimit && !hasParamErrors;

  const handleConfirm = async () => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    try {
      const selections: CloudWorkloadSelectionData[] = selectedIds.map((id) => ({
        workloadId: id,
        params: paramsByWorkload[id] ?? {},
      }));
      await onStart(purpose, selections);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败，请重试');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>启动容器</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
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
            {workloadsError ? (
              <div role="alert" className="space-y-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                <p>{workloadsError}</p>
                {onRetryWorkloads && (
                  <Button variant="outline" size="sm" onClick={onRetryWorkloads}>
                    重试
                  </Button>
                )}
              </div>
            ) : workloadsLoading ? (
              <p className="text-xs text-muted-foreground">加载中...</p>
            ) : workloads.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无可用工作负载</p>
            ) : (
              <ScrollArea className="max-h-48 rounded-md border p-2">
                <ul className="space-y-1">
                  {workloads.map((workload) => (
                    <li key={workload.id} className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        aria-label={workload.name}
                        checked={selectedIds.includes(workload.id)}
                        disabled={atLimit && !selectedIds.includes(workload.id)}
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
            <p className="text-xs text-muted-foreground">
              可多选，按勾选顺序依次执行；最多 {MAX_WORKLOADS_PER_START} 个。
            </p>
          </div>

          {selectedWorkloads.length > 0 && (
            <div className="min-w-0 space-y-3 rounded-lg border p-3">
              <p className="text-sm font-medium text-foreground">参数</p>
              {selectedWorkloads.map((workload) => {
                const missingDeps = (workload.dependsOnWorkloadIds ?? [])
                  .filter((depId) => !selectedIds.includes(depId))
                  .map((depId) => workloadById.get(depId)?.name ?? depId);
                return (
                  <div key={workload.id} className="min-w-0 space-y-2 rounded-md border p-3">
                    <p className="truncate text-sm font-medium text-foreground">{workload.name}</p>
                    {missingDeps.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        将自动初始化 {missingDeps.join('、')}（默认参数）
                      </p>
                    )}
                    <WorkloadParamsForm
                      workload={workload}
                      values={paramsByWorkload[workload.id] ?? {}}
                      errors={paramErrorsByWorkload[workload.id] ?? []}
                      onChange={(next) =>
                        setParamsByWorkload((prev) => ({ ...prev, [workload.id]: next }))
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}

          {selectedIds.length > 0 && (
            <div className="min-w-0 space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium text-foreground">初始化顺序预览</p>
              {preview.cycle ? (
                <p role="alert" className="text-xs text-destructive">
                  检测到依赖环：{preview.cycle.join(' → ')} → {preview.cycle[0]}
                </p>
              ) : (
                <ol className="min-w-0 space-y-1">
                  {preview.items.map((item) => (
                    <li key={item.workloadId} className="flex min-w-0 items-center gap-2 text-sm">
                      <span className="min-w-0 truncate text-foreground">{item.name}</span>
                      {item.implicit && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          隐式
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {overLimit && (
                <p role="alert" className="text-xs text-destructive">
                  展开依赖后超过单次挂载上限（{MAX_PLAN_ITEMS} 个），无法启动。
                </p>
              )}
            </div>
          )}
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
          <Button onClick={handleConfirm} disabled={starting || !canStart}>
            {starting ? '启动中...' : '确认启动'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
