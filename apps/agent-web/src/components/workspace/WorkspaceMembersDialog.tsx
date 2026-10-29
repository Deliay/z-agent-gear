import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import { toast } from 'sonner';
import {
  GET_TENANT_MEMBERS,
  GET_WORKSPACE_MEMBERS,
} from '@/graphql/queries';
import {
  ADD_WORKSPACE_MEMBER,
  REMOVE_WORKSPACE_MEMBER,
} from '@/graphql/mutations';
import type {
  AddWorkspaceMemberMutation,
  GetTenantMembersQuery,
  GetWorkspaceMembersQuery,
  RemoveWorkspaceMemberMutation,
  WorkspaceData,
} from '@/graphql/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface WorkspaceMembersDialogProps {
  open: boolean;
  workspace: WorkspaceData | null;
  onClose: () => void;
}

/** 普通工作区成员管理（仅租户 admin 可达；global 工作区恒无成员行，不开放入口）。 */
export default function WorkspaceMembersDialog({ open, workspace, onClose }: WorkspaceMembersDialogProps) {
  const workspaceId = workspace?.id ?? '';
  const tenantId = workspace?.tenant.id ?? '';
  const [selectedUserId, setSelectedUserId] = useState('');

  const { data: membersData, loading } = useQuery<GetWorkspaceMembersQuery>(GET_WORKSPACE_MEMBERS, {
    variables: { workspaceId },
    skip: !open || !workspaceId,
  });
  const { data: tenantMembersData } = useQuery<GetTenantMembersQuery>(GET_TENANT_MEMBERS, {
    variables: { tenantId },
    skip: !open || !tenantId,
  });

  const [addMember, { loading: adding }] = useMutation<AddWorkspaceMemberMutation>(
    ADD_WORKSPACE_MEMBER,
    { refetchQueries: [GET_WORKSPACE_MEMBERS, GET_TENANT_MEMBERS] },
  );
  const [removeMember] = useMutation<RemoveWorkspaceMemberMutation>(REMOVE_WORKSPACE_MEMBER, {
    refetchQueries: [GET_WORKSPACE_MEMBERS, GET_TENANT_MEMBERS],
  });

  const members = membersData?.workspaceMembers ?? [];
  const memberIds = new Set(members.map((member) => member.id));
  const candidates = (tenantMembersData?.tenantMembers ?? []).filter(
    (member) => !memberIds.has(member.id),
  );

  const handleAdd = async () => {
    if (!workspaceId || !selectedUserId) return;
    try {
      await addMember({ variables: { workspaceId, userId: selectedUserId } });
      setSelectedUserId('');
      toast.success('已添加工作区成员');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加成员失败');
    }
  };

  const handleRemove = async (userId: string) => {
    if (!workspaceId) return;
    try {
      await removeMember({ variables: { workspaceId, userId } });
      toast.success('已移除工作区成员');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移除成员失败');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>工作区成员</DialogTitle>
          <DialogDescription>{workspace?.name ?? ''}</DialogDescription>
        </DialogHeader>

        {loading && members.length === 0 ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : members.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            暂无成员（管理员天然可管理本工作区，可按需补充成员）
          </div>
        ) : (
          <ul className="space-y-2" aria-label="工作区成员列表">
            {members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
                <span className="min-w-0 truncate">
                  {member.name} <span className="text-muted-foreground">@{member.username}</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { void handleRemove(member.id); }}
                >
                  移除
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 border-t pt-4">
          <label htmlFor="workspace-member-candidate" className="text-sm font-medium">
            添加本租户成员
          </label>
          <div className="flex items-center gap-2">
            <select
              id="workspace-member-candidate"
              aria-label="选择本租户成员"
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 text-sm"
              value={selectedUserId}
              onChange={(event) => setSelectedUserId(event.target.value)}
            >
              <option value="">请选择成员</option>
              {candidates.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}（@{member.username}）
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!selectedUserId || adding}
              onClick={() => { void handleAdd(); }}
            >
              添加
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
