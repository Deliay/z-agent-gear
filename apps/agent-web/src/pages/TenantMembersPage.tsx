import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client/react';
import { toast } from 'sonner';
import { Search, Users } from 'lucide-react';
import { GET_TENANT_MEMBERS, SEARCH_ACCOUNTS } from '@/graphql/queries';
import {
  ADD_TENANT_MEMBER,
  CHANGE_TENANT_MEMBER_ROLE,
  REMOVE_TENANT_MEMBER,
} from '@/graphql/mutations';
import type {
  AddTenantMemberMutation,
  ChangeTenantMemberRoleMutation,
  GetTenantMembersQuery,
  RemoveTenantMemberMutation,
  SearchAccountsQuery,
  TenantRole,
  WorkspaceMemberData,
} from '@/graphql/types';
import { useWorkspaceStore } from '@/stores/workspace';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import MobileBackButton from '@/components/MobileBackButton';

const ROLE_LABEL: Record<TenantRole, string> = {
  admin: '管理员',
  developer: '开发',
};

function mapTenantMemberError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message.includes('last admin cannot be removed')) return '至少保留一名管理员，不能移除最后一名管理员';
  if (message.includes('last admin cannot be demoted')) return '至少保留一名管理员，不能降级最后一名管理员';
  if (message.includes('account not found')) return '帐号不存在';
  if (message.includes('already a member')) return '该帐号已是租户成员';
  if (message.includes('not a member')) return '该用户不是租户成员';
  if (message.includes('personal tenant is immutable')) return '个人租户成员不可变更';
  if (message.includes('not a tenant admin')) return '仅租户管理员可执行该操作';
  return message || '操作失败，请稍后重试';
}

export default function TenantMembersPage() {
  const { tenantId = '' } = useParams<{ tenantId: string }>();
  const { myTenants } = useWorkspaceStore();
  const membership = myTenants.find((item) => item.tenant.id === tenantId);
  const tenant = membership?.tenant ?? null;
  const isAdmin = membership?.role === 'admin';

  const [keyword, setKeyword] = useState('');
  const [submittedKeyword, setSubmittedKeyword] = useState('');
  const [addRole, setAddRole] = useState<TenantRole>('developer');
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceMemberData | null>(null);

  const { data: membersData, loading } = useQuery<GetTenantMembersQuery>(GET_TENANT_MEMBERS, {
    variables: { tenantId },
    skip: !tenantId || !isAdmin,
  });
  const { data: searchData, loading: searching } = useQuery<SearchAccountsQuery>(SEARCH_ACCOUNTS, {
    variables: { keyword: submittedKeyword },
    skip: !submittedKeyword,
  });

  const [addTenantMember] = useMutation<AddTenantMemberMutation>(ADD_TENANT_MEMBER, {
    refetchQueries: [GET_TENANT_MEMBERS],
  });
  const [changeRole] = useMutation<ChangeTenantMemberRoleMutation>(CHANGE_TENANT_MEMBER_ROLE, {
    refetchQueries: [GET_TENANT_MEMBERS],
  });
  const [removeTenantMember] = useMutation<RemoveTenantMemberMutation>(REMOVE_TENANT_MEMBER, {
    refetchQueries: [GET_TENANT_MEMBERS],
  });

  if (!tenant) {
    return (
      <div className="p-6" role="alert">
        <h1 className="text-lg font-semibold">租户成员</h1>
        <p className="mt-2 text-sm text-muted-foreground">未找到该租户或你不是该租户成员。</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="p-6" role="alert">
        <h1 className="text-lg font-semibold">租户成员</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          仅租户管理员可管理成员与角色（开发角色无入口）。
        </p>
      </div>
    );
  }

  if (tenant.type !== 'team') {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">租户成员</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          个人租户仅有一名成员且恒为管理员，无成员管理入口。
        </p>
      </div>
    );
  }

  const members = membersData?.tenantMembers ?? [];
  const memberIds = new Set(members.map((member) => member.id));
  const searchResults = (searchData?.searchAccounts ?? []).filter(
    (account) => !memberIds.has(account.userId),
  );

  const handleSearch = () => {
    setError(null);
    setSubmittedKeyword(keyword.trim());
  };

  const handleAdd = async (username: string) => {
    setError(null);
    try {
      await addTenantMember({ variables: { tenantId, username, role: addRole } });
      toast.success('已添加租户成员');
      setKeyword('');
      setSubmittedKeyword('');
    } catch (mutationError) {
      setError(mapTenantMemberError(mutationError));
    }
  };

  const handleChangeRole = async (member: WorkspaceMemberData, role: TenantRole) => {
    setError(null);
    try {
      await changeRole({ variables: { tenantId, userId: member.id, role } });
      toast.success('角色已更新');
    } catch (mutationError) {
      setError(mapTenantMemberError(mutationError));
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    setError(null);
    try {
      await removeTenantMember({ variables: { tenantId, userId: removeTarget.id } });
      toast.success('已移除租户成员');
    } catch (mutationError) {
      setError(mapTenantMemberError(mutationError));
    } finally {
      setRemoveTarget(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-8">
      <div className="mb-4 flex items-center gap-2 md:hidden">
        <MobileBackButton to="/" />
        <h1 className="text-lg font-semibold">租户成员</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{tenant.name} · 租户成员</CardTitle>
          <p className="text-sm text-muted-foreground">
            每租户至少保留一名管理员（last-admin 保护）。
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          {loading && members.length === 0 ? (
            <div className="text-sm text-muted-foreground">加载中...</div>
          ) : members.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              <Users className="size-8 text-muted-foreground/50" />
              暂无成员
            </div>
          ) : (
            <ul className="space-y-2" aria-label="租户成员列表">
              {members.map((member) => (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  data-testid={`tenant-member-row-${member.id}`}
                >
                  <div className="min-w-0">
                    <span className="font-medium">{member.name}</span>
                    <span className="ml-2 text-sm text-muted-foreground">@{member.username}</span>
                    <Badge variant="secondary" className="ml-2">
                      {member.role ? ROLE_LABEL[member.role] : '成员'}
                    </Badge>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      aria-label={`变更 ${member.username} 的角色`}
                      className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                      value={member.role ?? 'developer'}
                      onChange={(event) => {
                        void handleChangeRole(member, event.target.value as TenantRole);
                      }}
                    >
                      <option value="admin">管理员</option>
                      <option value="developer">开发</option>
                    </select>
                    <Button variant="destructive" size="sm" onClick={() => setRemoveTarget(member)}>
                      移除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">添加成员</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="搜索帐号"
                placeholder="按登录名搜索帐号"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleSearch();
                }}
                className="max-w-xs"
              />
              <select
                aria-label="新成员角色"
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={addRole}
                onChange={(event) => setAddRole(event.target.value as TenantRole)}
              >
                <option value="developer">开发</option>
                <option value="admin">管理员</option>
              </select>
              <Button size="sm" variant="outline" onClick={handleSearch}>
                <Search className="mr-1 size-4" />
                搜索
              </Button>
            </div>

            {searching && <div className="text-sm text-muted-foreground">搜索中...</div>}
            {submittedKeyword && !searching && searchResults.length === 0 && (
              <div className="text-sm text-muted-foreground">未找到可添加的帐号</div>
            )}
            {searchResults.length > 0 && (
              <ul className="space-y-2" aria-label="搜索结果">
                {searchResults.map((account) => (
                  <li
                    key={account.userId}
                    className="flex items-center justify-between gap-2 rounded border p-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {account.name} <span className="text-muted-foreground">@{account.username}</span>
                    </span>
                    <Button size="sm" onClick={() => { void handleAdd(account.username); }}>
                      添加
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
        title="移除租户成员"
        description={`确定将「${removeTarget?.name ?? ''}」移出本租户吗？其工作区成员关系将同步清理。`}
        confirmLabel="移除"
        onConfirm={handleRemove}
      />
    </div>
  );
}
