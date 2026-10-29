import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import { ADMIN_TENANT } from '@/graphql/queries'
import { ADMIN_ADD_TENANT_MEMBER, ADMIN_REMOVE_TENANT_MEMBER } from '@/graphql/mutations'
import type {
  AdminTenantUserData,
  GetAdminTenantQuery,
  TenantRole,
  TenantType,
} from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { QueryError } from '@/components/ui/query-error'
import AddMemberDialog from '@/components/tenants/AddMemberDialog'
import ChangeMemberRoleDialog from '@/components/tenants/ChangeMemberRoleDialog'
import {
  WORKSPACE_TYPE_LABELS,
  tenantRoleText,
} from '@/components/tenants/roles'
import { formatDateTime } from '@/lib/format'

const TENANT_TYPE_LABELS: Record<TenantType, string> = {
  personal: '个人',
  team: '团队',
}

/** 添加成员错误映射：账号不存在 / 重复 / 角色非法 / personal 拒绝 / 转发通道不可用 / 其余原样透出。 */
function mapAddMemberError(message: string): string {
  if (/ACCOUNT_NOT_FOUND|account not found/i.test(message)) return '账号不存在，请确认登录名'
  if (/ALREADY_MEMBER|already a member/i.test(message)) return '该账号已是租户成员'
  if (/INVALID_ROLE|invalid tenant role/i.test(message)) return '角色不合法'
  if (/TENANT_NOT_FOUND|tenant not found/i.test(message)) return '租户不存在或已被删除'
  if (/PERSONAL_TENANT_IMMUTABLE|personal tenant is immutable/i.test(message)) {
    return '个人租户不可管理成员'
  }
  if (/AGENT_API_UNAVAILABLE/.test(message)) {
    return '成员管理服务不可用（AGENT_API_UNAVAILABLE），请检查后台 AGENT_API_URL 配置'
  }
  return message || '添加成员失败，请重试'
}

/** 移除成员错误映射：last-admin 保护 / 已不是成员 / personal 拒绝 / 转发通道不可用 / 其余原样透出。 */
function mapRemoveMemberError(message: string): string {
  if (/LAST_ADMIN|last admin cannot be removed/i.test(message)) {
    return '该成员是租户最后一名管理员，无法移除（请先添加其他管理员）'
  }
  if (/NOT_MEMBER|not a member/i.test(message)) return '该账号已不是租户成员'
  if (/TENANT_NOT_FOUND|tenant not found/i.test(message)) return '租户不存在或已被删除'
  if (/PERSONAL_TENANT_IMMUTABLE|personal tenant is immutable/i.test(message)) {
    return '个人租户不可管理成员'
  }
  if (/AGENT_API_UNAVAILABLE/.test(message)) {
    return '成员管理服务不可用（AGENT_API_UNAVAILABLE），请检查后台 AGENT_API_URL 配置'
  }
  return message || '移除成员失败，请重试'
}

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data, loading, error, refetch } = useQuery<GetAdminTenantQuery>(ADMIN_TENANT, {
    variables: { id },
    skip: !id,
  })

  const tenant = data?.adminTenant ?? null
  const isTeam = tenant?.type === 'team'
  const workspaces = tenant?.workspaces ?? []

  const [addOpen, setAddOpen] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<AdminTenantUserData | null>(null)
  const [changeTarget, setChangeTarget] = useState<AdminTenantUserData | null>(null)
  const [changeError, setChangeError] = useState<string | null>(null)

  const [addMember, { loading: adding }] = useMutation(ADMIN_ADD_TENANT_MEMBER)
  const [removeMember, { loading: removing }] = useMutation(ADMIN_REMOVE_TENANT_MEMBER)

  const openBilling = () => {
    if (!tenant) return
    // 费用中心保持计费账户视角：按租户 id 检索其 tenant 计费账户（ownerId == tenantId），
    // BillingPage 读取该参数后自动预选账户并打开既有充值对话框入口。
    navigate(`/billing?ownerType=tenant&keyword=${encodeURIComponent(tenant.id)}`)
  }

  const openAdd = () => {
    setAddError(null)
    setAddOpen(true)
  }

  // 刷新失败不覆盖已完成操作的成功提示（下次进入页面/轮询会自愈）
  const refresh = async () => {
    try {
      await refetch()
    } catch {
      // ignore
    }
  }

  const submitAdd = async (username: string, role: TenantRole) => {
    if (!tenant) return
    setAddError(null)
    try {
      await addMember({ variables: { tenantId: tenant.id, username, role } })
      toast.success('成员已添加')
      setAddOpen(false)
      await refresh()
    } catch (err) {
      setAddError(mapAddMemberError(err instanceof Error ? err.message : ''))
    }
  }

  const confirmRemove = async () => {
    if (!tenant || !removeTarget) return
    try {
      await removeMember({ variables: { tenantId: tenant.id, userId: removeTarget.id } })
      toast.success('成员已移除')
      setRemoveTarget(null)
      await refresh()
    } catch (err) {
      // last-admin 等错误保留二次确认框并显式提示，避免误以为已移除
      toast.error(mapRemoveMemberError(err instanceof Error ? err.message : ''))
    }
  }

  const submitChangeRole = async (role: TenantRole) => {
    if (!tenant || !changeTarget) return
    setChangeError(null)
    try {
      // 本期后台无角色变更 mutation：以「移除 + 重新添加」实现
      await removeMember({ variables: { tenantId: tenant.id, userId: changeTarget.id } })
    } catch (err) {
      setChangeError(mapRemoveMemberError(err instanceof Error ? err.message : ''))
      return
    }
    try {
      await addMember({
        variables: { tenantId: tenant.id, username: changeTarget.username, role },
      })
    } catch (err) {
      await refresh()
      setChangeTarget(null)
      toast.error(
        `角色变更未完成：成员已被移除但重新添加失败（${mapAddMemberError(
          err instanceof Error ? err.message : '',
        )}），请在成员列表重新添加。`,
      )
      return
    }
    toast.success('角色已变更')
    setChangeTarget(null)
    await refresh()
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Link
        to="/tenants"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        返回租户列表
      </Link>

      {loading && !data ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : error && !data ? (
        <QueryError message={error.message} onRetry={() => refetch()} />
      ) : !tenant ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          租户不存在或已被移除
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate font-heading text-xl font-medium text-foreground">
                {tenant.name}
              </h1>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{tenant.id}</p>
            </div>
            <Button size="sm" onClick={openBilling}>
              充值
            </Button>
          </div>

          <section className="rounded-lg border p-4">
            <h2 className="mb-3 font-heading text-base font-medium text-foreground">租户概要</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">类型</dt>
                <dd className="mt-1">
                  <Badge variant="outline">
                    {TENANT_TYPE_LABELS[tenant.type] ?? tenant.type}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">成员数</dt>
                <dd className="mt-1 tabular-nums">{tenant.users.length}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">创建时间</dt>
                <dd className="mt-1">{formatDateTime(tenant.createdAt)}</dd>
              </div>
            </dl>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-heading text-base font-medium text-foreground">成员</h2>
              {isTeam && (
                <Button size="sm" variant="outline" onClick={openAdd}>
                  添加成员
                </Button>
              )}
            </div>
            {tenant.users.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无成员</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-0 text-sm">
                  <thead className="bg-muted/50 text-left text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">用户名</th>
                      <th className="px-4 py-2 font-medium">角色</th>
                      <th className="px-4 py-2 font-medium">创建时间</th>
                      {isTeam && <th className="px-4 py-2 text-right font-medium">操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {tenant.users.map((user) => (
                      <tr key={user.id} className="border-t">
                        <td className="px-4 py-3">
                          <div className="font-medium text-foreground">{user.username}</div>
                          {user.name && user.name !== user.username && (
                            <div className="text-xs text-muted-foreground">{user.name}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={user.role === 'admin' ? 'secondary' : 'outline'}>
                            {tenantRoleText(user.role)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatDateTime(user.createdAt)}
                        </td>
                        {isTeam && (
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setChangeError(null)
                                  setChangeTarget(user)
                                }}
                              >
                                变更角色
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => setRemoveTarget(user)}
                              >
                                移除
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="font-heading text-base font-medium text-foreground">工作区（只读）</h2>
            {workspaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无工作区</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-0 text-sm">
                  <thead className="bg-muted/50 text-left text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">名称</th>
                      <th className="px-4 py-2 font-medium">类型</th>
                      <th className="px-4 py-2 text-right font-medium">成员数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workspaces.map((workspace) => (
                      <tr key={workspace.id} className="border-t">
                        <td className="px-4 py-3 font-medium text-foreground">{workspace.name}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline">
                            {WORKSPACE_TYPE_LABELS[workspace.type] ?? workspace.type}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {workspace.memberCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <AddMemberDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            error={addError}
            submitting={adding}
            onSubmit={submitAdd}
          />

          <ChangeMemberRoleDialog
            open={changeTarget !== null}
            onOpenChange={(open) => {
              if (!open) setChangeTarget(null)
            }}
            username={changeTarget?.username ?? ''}
            currentRole={changeTarget?.role ?? 'developer'}
            error={changeError}
            submitting={removing || adding}
            onSubmit={submitChangeRole}
          />

          <ConfirmDialog
            open={removeTarget !== null}
            onOpenChange={(open) => {
              if (!open) setRemoveTarget(null)
            }}
            title="移除成员"
            description={`确认将「${removeTarget?.username ?? ''}」移出租户？该成员将立即失去本租户全部工作区访问权限（资源与工作区保留）。`}
            confirmLabel="移除"
            loadingLabel="移除中..."
            loading={removing}
            onConfirm={confirmRemove}
          />
        </>
      )}
    </div>
  )
}
