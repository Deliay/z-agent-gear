import { useEffect, useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { RefreshCw } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ADMIN_CLOUD_WORKLOAD_LOGS } from '@/graphql/queries';
import type {
  CloudWorkloadLogData,
  CloudWorkloadLogStatus,
  GetAdminCloudContainerWorkloadLogsQuery,
} from '@/graphql/types';
import { formatDateTime } from '@/lib/format';
import { formatParams } from '@/lib/workload-params';
import { REQUIRED_LABEL, WORKLOAD_LOG_PHASE_LABELS, WORKLOAD_LOG_STATUS_LABELS } from './labels';

interface WorkloadLogsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  containerId: string;
  containerName: string;
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

const STATUS_VARIANTS: Record<CloudWorkloadLogStatus, BadgeVariant> = {
  PENDING: 'secondary',
  RUNNING: 'secondary',
  SUCCESS: 'default',
  FAILED: 'destructive',
  TIMEOUT: 'outline',
};

/** 执行记录轮询间隔：PRD 功能点 5 要求「执行中的记录实时可刷新」（5s，与容器列表同源节奏）。 */
export const WORKLOAD_LOGS_POLL_INTERVAL_MS = 5000;

export default function WorkloadLogsDialog({
  open,
  onOpenChange,
  containerId,
  containerName,
}: WorkloadLogsDialogProps) {
  // 独立查询：轮询刷新容器列表不打断本对话框（frontend-rules：对话框状态独立于列表）。
  // pollInterval 让「执行中」的记录在对话框打开期间自动推进到成功/失败/超时（PRD 功能点 5）。
  const { data, loading, error, refetch } = useQuery<GetAdminCloudContainerWorkloadLogsQuery>(
    ADMIN_CLOUD_WORKLOAD_LOGS,
    {
      variables: { containerId },
      skip: !open || !containerId,
      pollInterval: WORKLOAD_LOGS_POLL_INTERVAL_MS,
    },
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setSelectedId(null);
  }, [open]);

  const logs = data?.adminCloudContainerWorkloadLogs ?? [];
  // 保留用户选中的记录：轮询刷新后仍按 id 定位，仅在记录消失时回退首条（不重置选择）
  const selected: CloudWorkloadLogData | null =
    logs.find((item) => item.id === selectedId) ?? logs[0] ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>工作负载执行日志</DialogTitle>
          <DialogDescription className="min-w-0 truncate">{containerName}</DialogDescription>
        </DialogHeader>

        {loading && !data ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : error && !data ? (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error.message}
          </div>
        ) : logs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            暂无执行记录
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row">
            <div className="min-w-0 shrink-0 space-y-2 sm:w-60">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                aria-label="刷新工作负载日志"
                onClick={() => refetch()}
              >
                <RefreshCw className="mr-1 size-3.5" />
                刷新
              </Button>
              <ScrollArea className="min-w-0 rounded-md border">
                <ul className="divide-y">
                  {logs.map((item) => (
                    <li key={item.id} className="min-w-0">
                      <button
                        type="button"
                        aria-label={`查看 ${item.workloadName} ${WORKLOAD_LOG_PHASE_LABELS[item.phase]}`}
                        onClick={() => setSelectedId(item.id)}
                        className={`flex w-full min-w-0 flex-col gap-1 p-3 text-left transition-colors hover:bg-muted ${
                          selected?.id === item.id ? 'bg-muted' : ''
                        }`}
                      >
                        <span className="block max-w-full truncate text-sm font-medium text-foreground">
                          {item.workloadName}
                        </span>
                        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{WORKLOAD_LOG_PHASE_LABELS[item.phase]}</span>
                          {item.required && (
                            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                              {REQUIRED_LABEL}
                            </span>
                          )}
                          <Badge variant={STATUS_VARIANTS[item.status]}>
                            {WORKLOAD_LOG_STATUS_LABELS[item.status]}
                          </Badge>
                        </span>
                        <span className="block max-w-full truncate text-xs text-muted-foreground">
                          {formatDateTime(item.startedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </div>

            {selected && (
              <div className="min-w-0 flex-1 space-y-3">
                {selected.required && (
                  <span className="inline-block rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                    {REQUIRED_LABEL}
                  </span>
                )}
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">脚本快照</p>
                  <pre className="max-h-40 min-w-0 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                    {selected.script}
                  </pre>
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">参数快照</p>
                  <pre className="max-h-32 min-w-0 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                    {formatParams(selected.params)}
                  </pre>
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">输出日志</p>
                  <pre className="max-h-48 min-w-0 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                    {selected.log || '(无输出)'}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
