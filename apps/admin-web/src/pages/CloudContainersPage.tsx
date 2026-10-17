import { useState } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { toast } from 'sonner';
import { Cloud } from 'lucide-react';
import { ADMIN_CLOUD_CONTAINERS, ADMIN_CLOUD_WORKLOADS } from '@/graphql/queries';
import {
  ADMIN_START_CLOUD_CONTAINER,
  ADMIN_DESTROY_CLOUD_CONTAINER,
} from '@/graphql/mutations';
import type {
  CloudContainerData,
  CloudContainerPurpose,
  CloudWorkloadSelectionData,
  GetAdminCloudContainersQuery,
  GetAdminCloudWorkloadsQuery,
} from '@/graphql/types';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { QueryError } from '@/components/ui/query-error';
import { formatDateTime, formatOnlineDuration } from '@/lib/format';
import ContainerStatusBadge from '@/components/cloud-containers/ContainerStatusBadge';
import StartContainerDialog from '@/components/cloud-containers/StartContainerDialog';
import DestroyConfirmDialog from '@/components/cloud-containers/DestroyConfirmDialog';
import WorkloadLogsDialog from '@/components/cloud-containers/WorkloadLogsDialog';
import { CONTAINER_PURPOSE_LABELS } from '@/components/cloud-containers/labels';

export default function CloudContainersPage() {
  // 10s 轮询（Apollo v4：加载分支必须 `loading && !data`，否则每次轮询卸载整页）
  const { data, loading, error, refetch } = useQuery<GetAdminCloudContainersQuery>(ADMIN_CLOUD_CONTAINERS, {
    pollInterval: 10000,
  });
  // 启动对话框可选的工作负载；独立查询，不影响容器轮询
  const {
    data: workloadsData,
    loading: workloadsLoading,
    error: workloadsError,
    refetch: refetchWorkloads,
  } = useQuery<GetAdminCloudWorkloadsQuery>(ADMIN_CLOUD_WORKLOADS);
  const [startContainer] = useMutation(ADMIN_START_CLOUD_CONTAINER);
  const [destroyContainer] = useMutation(ADMIN_DESTROY_CLOUD_CONTAINER);

  const [startOpen, setStartOpen] = useState(false);
  const [destroying, setDestroying] = useState<CloudContainerData | null>(null);
  const [destroyBusy, setDestroyBusy] = useState(false);
  const [logsFor, setLogsFor] = useState<CloudContainerData | null>(null);

  const containers = data?.adminCloudContainers ?? [];
  const workloads = workloadsData?.adminCloudWorkloads ?? [];
  // 降级提示由契约字段承载（控制面在线标记），而非依赖 Apollo error
  const controlPlaneOffline = data?.adminCloudContainerControlPlane?.online === false;

  const handleStart = async (
    purpose: CloudContainerPurpose,
    workloadsSelection: CloudWorkloadSelectionData[],
  ) => {
    await startContainer({
      variables: { purpose, workloads: workloadsSelection },
      refetchQueries: [ADMIN_CLOUD_CONTAINERS],
    });
  };

  const handleDestroyConfirm = async () => {
    if (!destroying) return;
    setDestroyBusy(true);
    try {
      await destroyContainer({
        variables: { id: destroying.id },
        refetchQueries: [ADMIN_CLOUD_CONTAINERS],
      });
      setDestroying(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '强制销毁失败，请重试');
    } finally {
      setDestroyBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-xl font-medium text-foreground">云端容器</h1>
        <Button size="sm" onClick={() => setStartOpen(true)}>
          启动
        </Button>
      </div>

      {controlPlaneOffline && (
        <div role="status" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {data?.adminCloudContainerControlPlane?.message || '控制面离线'}，展示最近一次落库状态。
        </div>
      )}

      {loading && !data ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : error && !data ? (
        <QueryError message={error.message} onRetry={() => refetch()} />
      ) : containers.length === 0 ? (
        <div className="rounded-lg border border-dashed">
          <EmptyState
            icon={Cloud}
            title="暂无云端容器"
            description="点击「启动」创建一个空闲测试容器"
            action={
              <Button size="sm" onClick={() => setStartOpen(true)}>
                立即启动
              </Button>
            }
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-0 text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">名称</th>
                <th className="px-4 py-2 font-medium">状态</th>
                <th className="px-4 py-2 font-medium">用途</th>
                <th className="px-4 py-2 font-medium">关联对象</th>
                <th className="px-4 py-2 font-medium">工作负载</th>
                <th className="px-4 py-2 font-medium">创建时间</th>
                <th className="px-4 py-2 font-medium">在线时长</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((container) => (
                <tr key={container.id} className="border-t">
                  <td className="px-4 py-3 font-medium text-foreground">{container.name}</td>
                  <td className="px-4 py-3">
                    <ContainerStatusBadge status={container.status} />
                    {container.status === 'INITIALIZING' && container.currentWorkloadName ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {container.currentWorkloadName}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {CONTAINER_PURPOSE_LABELS[container.purpose]}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{container.refId ?? '-'}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {container.workloads?.length ? (
                      <span className="flex flex-wrap gap-1">
                        {container.workloads.map((workload) => (
                          <span
                            key={workload.id}
                            className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
                          >
                            {workload.name}
                          </span>
                        ))}
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDateTime(container.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatOnlineDuration(container)}
                    {container.exitReason ? (
                      <span className="ml-2 text-xs text-destructive">{container.exitReason}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`工作负载日志 ${container.name}`}
                        onClick={() => setLogsFor(container)}
                      >
                        工作负载日志
                      </Button>
                      <Button
                        variant="ghost-danger"
                        size="sm"
                        aria-label={`强制销毁 ${container.name}`}
                        onClick={() => setDestroying(container)}
                      >
                        强制销毁
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <StartContainerDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        workloads={workloads}
        workloadsLoading={workloadsLoading && !workloadsData}
        workloadsError={workloadsError && !workloadsData ? workloadsError.message : null}
        onRetryWorkloads={() => refetchWorkloads()}
        onStart={handleStart}
      />

      <DestroyConfirmDialog
        open={destroying !== null}
        onOpenChange={(open) => {
          if (!open) setDestroying(null);
        }}
        containerName={destroying?.name ?? ''}
        onConfirm={handleDestroyConfirm}
        loading={destroyBusy}
      />

      <WorkloadLogsDialog
        open={logsFor !== null}
        onOpenChange={(open) => {
          if (!open) setLogsFor(null);
        }}
        containerId={logsFor?.id ?? ''}
        containerName={logsFor?.name ?? ''}
      />
    </div>
  );
}
