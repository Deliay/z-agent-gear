import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import { toast } from 'sonner';
import { ADMIN_CLOUD_SPECS } from '@/graphql/queries';
import {
  CREATE_CLOUD_SPEC,
  UPDATE_CLOUD_SPEC,
  DELETE_CLOUD_SPEC,
} from '@/graphql/mutations';
import type {
  AdminCloudSpecData,
  AdminCloudSpecInputData,
  GetAdminCloudSpecsQuery,
} from '@/graphql/types';
import { mapSpecError } from '@/lib/cloud-host-spec';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Input } from '@/components/ui/input';
import SpecTable from '@/components/cloud-host-specs/SpecTable';
import SpecFormDialog from '@/components/cloud-host-specs/SpecFormDialog';
import DeleteSpecDialog from '@/components/cloud-host-specs/DeleteSpecDialog';

export default function CloudHostSpecsPage() {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const { data, loading, error, refetch } = useQuery<GetAdminCloudSpecsQuery>(ADMIN_CLOUD_SPECS, {
    variables: { keyword: keyword.trim() || null, page, pageSize },
  });
  const [createSpec] = useMutation(CREATE_CLOUD_SPEC);
  const [updateSpec] = useMutation(UPDATE_CLOUD_SPEC);
  const [deleteSpec] = useMutation(DELETE_CLOUD_SPEC);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminCloudSpecData | null>(null);
  const [deleting, setDeleting] = useState<AdminCloudSpecData | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const specs = data?.adminCloudSpecs ?? [];

  useEffect(() => {
    setPage(1);
  }, [keyword]);

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

  const handleEdit = (spec: AdminCloudSpecData) => {
    setEditing(spec);
    setFormOpen(true);
  };

  const handleSave = async (input: AdminCloudSpecInputData) => {
    if (editing) {
      await updateSpec({
        variables: { id: editing.id, input },
        refetchQueries: [ADMIN_CLOUD_SPECS],
      });
      toast.success('容器规格已更新');
    } else {
      await createSpec({
        variables: { input },
        refetchQueries: [ADMIN_CLOUD_SPECS],
      });
      toast.success('容器规格已创建');
    }
    setEditing(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await deleteSpec({
        variables: { id: deleting.id },
        refetchQueries: [ADMIN_CLOUD_SPECS],
      });
      toast.success('容器规格已删除');
      setDeleting(null);
    } catch (err) {
      toast.error(mapSpecError(err instanceof Error ? err.message : ''));
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-medium text-foreground">容器规格</h1>
          <p className="text-xs text-muted-foreground">
            维护云电脑算力档位；开启白名单后仅所选租户可见，未开启时全部租户可见。
          </p>
        </div>
        <Button size="sm" onClick={handleCreate}>
          新建规格
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="搜索规格"
          placeholder="按名称搜索"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          className="max-w-xs"
        />
      </div>

      {loading && !data ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : error && !data ? (
        <QueryError message={error.message} onRetry={() => refetch()} />
      ) : (
        <SpecTable
          specs={specs}
          onEdit={handleEdit}
          onDelete={(spec) => setDeleting(spec)}
        />
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          上一页
        </Button>
        <span className="text-xs text-muted-foreground">第 {page} 页</span>
        <Button
          size="sm"
          variant="outline"
          disabled={specs.length < pageSize}
          onClick={() => setPage((current) => current + 1)}
        >
          下一页
        </Button>
      </div>

      <SpecFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        initialData={editing}
        onSave={handleSave}
      />

      <DeleteSpecDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        specName={deleting?.name ?? ''}
        onConfirm={handleDeleteConfirm}
        loading={deletingBusy}
      />
    </div>
  );
}
