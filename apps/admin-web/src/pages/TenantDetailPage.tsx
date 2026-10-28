import { useQuery } from '@apollo/client/react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { ADMIN_TENANT } from '@/graphql/queries'
import type { GetAdminTenantQuery, TenantType } from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { QueryError } from '@/components/ui/query-error'
import { formatDateTime } from '@/lib/format'

const TENANT_TYPE_LABELS: Record<TenantType, string> = {
  personal: '个人',
  team: '团队',
}

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data, loading, error, refetch } = useQuery<GetAdminTenantQuery>(ADMIN_TENANT, {
    variables: { id },
    skip: !id,
  })

  const tenant = data?.adminTenant ?? null

  const openBilling = () => {
    if (!tenant) return
    // 费用中心保持计费账户视角：按租户 id 检索其 tenant 计费账户（ownerId == tenantId），
    // BillingPage 读取该参数后自动预选账户并打开既有充值对话框入口。
    navigate(`/billing?ownerType=tenant&keyword=${encodeURIComponent(tenant.id)}`)
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
            <h2 className="font-heading text-base font-medium text-foreground">成员</h2>
            {tenant.users.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无成员</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-0 text-sm">
                  <thead className="bg-muted/50 text-left text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">用户名</th>
                      <th className="px-4 py-2 font-medium">创建时间</th>
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
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatDateTime(user.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
