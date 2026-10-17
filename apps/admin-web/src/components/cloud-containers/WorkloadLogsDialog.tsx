import { useEffect, useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ADMIN_CLOUD_WORKLOAD_LOGS } from '@/graphql/queries';
import type {
  CloudWorkloadLogData,
  CloudWorkloadLogStatus,
  GetAdminCloudContainerWorkloadLogsQuery,
} from '@/graphql/types';
import { formatDateTime } from '@/lib/format';
import { WORKLOAD_LOG_PHASE_LABELS, WORKLOAD_LOG_STATUS_LABELS } from './labels';

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

export default function WorkloadLogsDialog({
  open,
  onOpenChange,
  containerId,
  containerName,
}: WorkloadLogsDialogProps) {
  // 独立查询：轮询刷新容器列表不打断本对话框（frontend-rules：对话框状态独立于列表）
  const { data, loading, error } = useQuery<GetAdminCloudContainerWorkloadLogsQuery>(
    ADMIN_CLOUD_WORKLOAD_LOGS,
    { variables: { containerId }, skip: !open || !containerId },
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setSelectedId(null);
  }, [open]);

  const logs = data?.adminCloudContainerWorkloadLogs ?? [];
  const selected: CloudWorkloadLogData | null =
    logs.find((item) => item.id === selectedId) ?? logs[0] ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 sm:max-w-3xl">
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
            <ScrollArea className="min-w-0 shrink-0 rounded-md border sm:w-60">
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

            {selected && (
              <div className="min-w-0 flex-1 space-y-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">脚本快照</p>
                  <pre className="max-h-40 min-w-0 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                    {selected.script}
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
