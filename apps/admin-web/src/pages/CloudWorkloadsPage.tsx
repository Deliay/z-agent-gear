import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { toast } from 'sonner';
import { ADMIN_CLOUD_WORKLOADS } from '@/graphql/queries';
import {
  CREATE_CLOUD_WORKLOAD,
  UPDATE_CLOUD_WORKLOAD,
  DELETE_CLOUD_WORKLOAD,
} from '@/graphql/mutations';
import type {
  CloudWorkloadData,
  CloudWorkloadInputData,
  GetAdminCloudWorkloadsQuery,
} from '@/graphql/types';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import WorkloadTable from '@/components/cloud-workloads/WorkloadTable';
import WorkloadFormDialog from '@/components/cloud-workloads/WorkloadFormDialog';
import DeleteWorkloadDialog from '@/components/cloud-workloads/DeleteWorkloadDialog';

export default function CloudWorkloadsPage() {
  const { data, loading, error, refetch } = useQuery<GetAdminCloudWorkloadsQuery>(ADMIN_CLOUD_WORKLOADS);
  const [createWorkload] = useMutation(CREATE_CLOUD_WORKLOAD);
  const [updateWorkload] = useMutation(UPDATE_CLOUD_WORKLOAD);
  const [deleteWorkload] = useMutation(DELETE_CLOUD_WORKLOAD);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CloudWorkloadData | null>(null);
  const [deleting, setDeleting] = useState<CloudWorkloadData | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const workloads = data?.adminCloudWorkloads ?? [];

  // 初始加载失败走整页错误态；已有数据后的刷新失败不替换内容，改用 toast 显式提示
  useEffect(() => {
    if (error && data) {
      toast.error(error.message || '数据刷新失败');
    }
  }, [error, data]);

  const handleCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const handleEdit = (workload: CloudWorkloadData) => {
    setEditing(workload);
    setFormOpen(true);
  };

  const handleSave = async (input: CloudWorkloadInputData) => {
    if (editing) {
      await updateWorkload({
        variables: { id: editing.id, input },
        refetchQueries: [ADMIN_CLOUD_WORKLOADS],
      });
    } else {
      await createWorkload({
        variables: { input },
        refetchQueries: [ADMIN_CLOUD_WORKLOADS],
      });
    }
    setEditing(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await deleteWorkload({
        variables: { id: deleting.id },
        refetchQueries: [ADMIN_CLOUD_WORKLOADS],
      });
      setDeleting(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试');
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-xl font-medium text-foreground">工作负载</h1>
        <Button size="sm" onClick={handleCreate}>
          新建工作负载
        </Button>
      </div>

      {loading && !data ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : error && !data ? (
        <QueryError message={error.message} onRetry={() => refetch()} />
      ) : (
        <WorkloadTable
          workloads={workloads}
          onEdit={handleEdit}
          onDelete={(workload) => setDeleting(workload)}
        />
      )}

      <WorkloadFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        initialData={editing}
        onSave={handleSave}
        dependencyCandidates={workloads}
      />

      <DeleteWorkloadDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        workloadName={deleting?.name ?? ''}
        onConfirm={handleDeleteConfirm}
        loading={deletingBusy}
      />
    </div>
  );
}
