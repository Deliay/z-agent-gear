import { useState } from 'react';
import { useMutation } from '@apollo/client/react';
import { toast } from 'sonner';
import { Boxes, Plus } from 'lucide-react';
import { GET_WORKSPACE_CONTEXT } from '@/graphql/queries';
import {
  CREATE_TENANT_WORKSPACE,
  DELETE_TENANT_WORKSPACE,
  RENAME_TENANT_WORKSPACE,
} from '@/graphql/mutations';
import type {
  CreateTenantWorkspaceMutation,
  DeleteTenantWorkspaceMutation,
  RenameTenantWorkspaceMutation,
  WorkspaceData,
} from '@/graphql/types';
import { useWorkspaceStore } from '@/stores/workspace';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import WorkspaceMembersDialog from '@/components/workspace/WorkspaceMembersDialog';
import MobileBackButton from '@/components/MobileBackButton';

function mapWorkspaceError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message.includes('workspace name already exists')) return '工作区名称已存在';
  if (message.includes('workspace is not empty')) return '工作区非空（仍持有资源），无法删除';
  if (message.includes('global workspace is immutable')) return '全局工作区不可修改或删除';
  if (message.includes('personal tenant cannot create workspaces')) return '个人租户不能创建工作区';
  if (message.includes('not a tenant admin')) return '仅租户管理员可执行该操作';
  return message || '操作失败，请稍后重试';
}

type WorkspaceFormMode = 'create' | 'rename';

export default function WorkspacePage() {
  const { current, myWorkspaces, initialized } = useWorkspaceStore();
  const [formMode, setFormMode] = useState<WorkspaceFormMode | null>(null);
  const [formName, setFormName] = useState('');
  const [formTarget, setFormTarget] = useState<WorkspaceData | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceData | null>(null);
  const [membersTarget, setMembersTarget] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [createWorkspace, { loading: creating }] = useMutation<CreateTenantWorkspaceMutation>(
    CREATE_TENANT_WORKSPACE,
    { refetchQueries: [GET_WORKSPACE_CONTEXT] },
  );
  const [renameWorkspace, { loading: renaming }] = useMutation<RenameTenantWorkspaceMutation>(
    RENAME_TENANT_WORKSPACE,
    { refetchQueries: [GET_WORKSPACE_CONTEXT] },
  );
  const [deleteWorkspace, { loading: deleting }] = useMutation<DeleteTenantWorkspaceMutation>(
    DELETE_TENANT_WORKSPACE,
    { refetchQueries: [GET_WORKSPACE_CONTEXT] },
  );

  const tenant = current?.tenant ?? null;
  const isAdmin = current?.myRole === 'admin';
  const workspaces = tenant
    ? myWorkspaces.filter((workspace) => workspace.tenant.id === tenant.id)
    : [];

  if (!initialized) {
    return <div className="p-6 text-sm text-muted-foreground">加载中...</div>;
  }

  if (!current || !tenant) {
    return <div className="p-6 text-sm text-muted-foreground">无法确定当前工作区</div>;
  }

  if (!isAdmin) {
    return (
      <div className="p-6" role="alert">
        <h1 className="text-lg font-semibold">工作区管理</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          仅租户管理员可访问工作区管理（开发角色无入口）。
        </p>
      </div>
    );
  }

  if (tenant.type !== 'team') {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">工作区管理</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          个人租户仅有全局工作区，无工作区管理入口。
        </p>
      </div>
    );
  }

  const openCreate = () => {
    setFormMode('create');
    setFormName('');
    setFormTarget(null);
    setError(null);
  };

  const openRename = (workspace: WorkspaceData) => {
    setFormMode('rename');
    setFormName(workspace.name);
    setFormTarget(workspace);
    setError(null);
  };

  const submitForm = async () => {
    const name = formName.trim();
    if (!name) {
      setError('请输入工作区名称');
      return;
    }
    setError(null);
    try {
      if (formMode === 'create') {
        await createWorkspace({ variables: { name } });
        toast.success('工作区已创建');
      } else if (formMode === 'rename' && formTarget) {
        await renameWorkspace({ variables: { id: formTarget.id, name } });
        toast.success('工作区已重命名');
      }
      setFormMode(null);
      setFormTarget(null);
    } catch (mutationError) {
      setError(mapWorkspaceError(mutationError));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteWorkspace({ variables: { id: deleteTarget.id } });
      toast.success('工作区已删除');
      setDeleteTarget(null);
    } catch (mutationError) {
      toast.error(mapWorkspaceError(mutationError));
      setDeleteTarget(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-8">
      <div className="mb-4 flex items-center gap-2 md:hidden">
        <MobileBackButton to="/" />
        <h1 className="text-lg font-semibold">工作区管理</h1>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>工作区管理</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {tenant.name} · 工作区隔离资源并决定资源可见范围
              </p>
            </div>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 size-4" />
              新建工作区
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {workspaces.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              <Boxes className="size-8 text-muted-foreground/50" />
              暂无工作区
            </div>
          ) : (
            <ul className="space-y-2" aria-label="工作区列表">
              {workspaces.map((workspace) => (
                <li
                  key={workspace.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  data-testid={`workspace-row-${workspace.id}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{workspace.name}</span>
                      <Badge variant={workspace.type === 'global' ? 'secondary' : 'outline'}>
                        {workspace.type === 'global' ? '全局工作区' : '普通工作区'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {workspace.memberCount} 位成员
                    </p>
                  </div>
                  {workspace.type === 'normal' && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => openRename(workspace)}>
                        改名
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setMembersTarget(workspace)}>
                        成员
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(workspace)}>
                        删除
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={formMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setFormMode(null);
            setFormTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{formMode === 'create' ? '新建工作区' : '重命名工作区'}</DialogTitle>
            <DialogDescription>名称在同租户内唯一</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              aria-label="工作区名称"
              value={formName}
              maxLength={64}
              autoFocus
              onChange={(event) => setFormName(event.target.value)}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormMode(null)}>
              取消
            </Button>
            <Button onClick={() => { void submitForm(); }} disabled={creating || renaming}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除工作区"
        description={`确定删除「${deleteTarget?.name ?? ''}」吗？工作区内仍有资源时会被拒绝。`}
        confirmLabel="删除"
        loading={deleting}
        onConfirm={confirmDelete}
      />

      <WorkspaceMembersDialog
        open={membersTarget !== null}
        workspace={membersTarget}
        onClose={() => setMembersTarget(null)}
      />
    </div>
  );
}
