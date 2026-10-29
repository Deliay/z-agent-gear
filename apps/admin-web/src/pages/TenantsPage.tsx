import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Building2 } from 'lucide-react'
import { ADMIN_TENANTS } from '@/graphql/queries'
import { ADMIN_CREATE_FRONT_USER, ADMIN_CREATE_TEAM_TENANT } from '@/graphql/mutations'
import type { AdminTenantData, GetAdminTenantsQuery, TenantType } from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { formatDateTime } from '@/lib/format'

const TENANT_TYPE_LABELS: Record<TenantType, string> = {
  personal: '个人',
  team: '团队',
}

const PAGE_SIZE = 20

/** 与 agent-api 开户校验同口径（规则单一来源在服务端，这里只做本地预校验）。 */
function validateUsername(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length < 2 || trimmed.length > 20) return '用户名长度需为 2-20 个字符'
  return null
}

function validatePassword(value: string): string | null {
  if (value.length < 6) return '密码至少 6 位'
  return null
}

/** 团队租户名称校验：与 agent-api `/internal/tenants` 同口径（trim 后 1-60 字符）。 */
function validateTeamName(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > 60) return '租户名称长度需为 1-60 个字符'
  return null
}

/** 开户错误映射：重名 / 规则非法 / 开户通道未配置 / 其余原样透出。 */
function mapCreateError(message: string): string {
  if (/USERNAME_TAKEN|Username already taken/i.test(message)) return '用户名已被占用'
  if (/Username must be between 2 and 20 characters/i.test(message)) {
    return '用户名长度需为 2-20 个字符'
  }
  if (/Password must be at least 6 characters/i.test(message)) return '密码至少 6 位'
  if (/AGENT_API_UNAVAILABLE/.test(message)) {
    return '开户服务不可用（AGENT_API_UNAVAILABLE），请检查后台 AGENT_API_URL 配置'
  }
  return message || '开户失败，请重试'
}

/** 创建团队租户错误映射：重名 / 名称非法 / 计费或转发通道不可用 / 其余原样透出。 */
function mapCreateTeamError(message: string): string {
  if (/TENANT_NAME_TAKEN|tenant name already exists/i.test(message)) return '租户名称已存在'
  if (/INVALID_BODY|INVALID_ARGUMENT|length/i.test(message)) return '租户名称长度需为 1-60 个字符'
  if (/BILLING_UNAVAILABLE/i.test(message)) return '计费服务不可用，请稍后重试'
  if (/AGENT_API_UNAVAILABLE/.test(message)) {
    return '团队租户服务不可用（AGENT_API_UNAVAILABLE），请检查后台 AGENT_API_URL 配置'
  }
  return message || '创建团队租户失败，请重试'
}

function tenantBalanceText(balance: number | null): string {
  return balance == null ? '-' : balance.toFixed(2)
}

export default function TenantsPage() {
  const navigate = useNavigate()
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [teamOpen, setTeamOpen] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [teamError, setTeamError] = useState<string | null>(null)

  const { data, loading, error, refetch } = useQuery<GetAdminTenantsQuery>(ADMIN_TENANTS, {
    variables: { keyword: keyword || null, page, pageSize: PAGE_SIZE },
  })
  const [createFrontUser, { loading: creating }] = useMutation(ADMIN_CREATE_FRONT_USER)
  const [createTeamTenant, { loading: creatingTeam }] = useMutation(ADMIN_CREATE_TEAM_TENANT)

  const tenants = data?.adminTenants ?? []

  // 初始加载失败走整页错误态；已有数据后的刷新失败不替换内容，改用 toast 显式提示
  useEffect(() => {
    if (error && data) {
      toast.error(error.message || '数据刷新失败')
    }
  }, [error, data])

  const openCreate = () => {
    setUsername('')
    setPassword('')
    setFormError(null)
    setCreateOpen(true)
  }

  const submitCreate = async () => {
    const usernameError = validateUsername(username)
    if (usernameError) {
      setFormError(usernameError)
      return
    }
    const passwordError = validatePassword(password)
    if (passwordError) {
      setFormError(passwordError)
      return
    }
    setFormError(null)
    try {
      await createFrontUser({
        variables: { username: username.trim(), password },
        refetchQueries: [ADMIN_TENANTS],
      })
      toast.success('开户成功')
      setCreateOpen(false)
      setUsername('')
      setPassword('')
    } catch (err) {
      setFormError(mapCreateError(err instanceof Error ? err.message : ''))
    }
  }

  const openTeam = () => {
    setTeamName('')
    setTeamError(null)
    setTeamOpen(true)
  }

  const submitTeam = async () => {
    const nameError = validateTeamName(teamName)
    if (nameError) {
      setTeamError(nameError)
      return
    }
    setTeamError(null)
    try {
      await createTeamTenant({
        variables: { name: teamName.trim() },
        refetchQueries: [ADMIN_TENANTS],
      })
      toast.success('团队租户创建成功')
      setTeamOpen(false)
      setTeamName('')
    } catch (err) {
      setTeamError(mapCreateTeamError(err instanceof Error ? err.message : ''))
    }
  }

  const openTenant = (tenant: AdminTenantData) => {
    navigate(`/tenants/${tenant.id}`)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-xl font-medium text-foreground">租户管理</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={openTeam}>
            创建团队租户
          </Button>
          <Button size="sm" onClick={openCreate}>
            开户
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <Input
          className="max-w-xs"
          value={keyword}
          aria-label="租户名称检索"
          placeholder="按租户名称检索"
          onChange={(event) => {
            setKeyword(event.target.value)
            // 检索条件变化时重置页码，避免停留在旧范围的空页
            setPage(1)
          }}
        />

        {loading && !data ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : error && !data ? (
          <QueryError message={error.message} onRetry={() => refetch()} />
        ) : tenants.length === 0 ? (
          <div className="rounded-lg border border-dashed">
            <EmptyState
              icon={Building2}
              title="暂无租户"
              description="点击「开户」创建前台登录账户与其个人专属租户，或「创建团队租户」开通团队空间"
            />
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-0 text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">名称</th>
                  <th className="px-4 py-2 font-medium">类型</th>
                  <th className="px-4 py-2 text-right font-medium">成员数</th>
                  <th className="px-4 py-2 text-right font-medium">余额</th>
                  <th className="px-4 py-2 font-medium">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => (
                  <tr
                    key={tenant.id}
                    className="cursor-pointer border-t hover:bg-muted/50"
                    onClick={() => openTenant(tenant)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openTenant(tenant)
                      }
                    }}
                    tabIndex={0}
                  >
                    <td className="px-4 py-3 font-medium text-foreground">{tenant.name}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">
                        {TENANT_TYPE_LABELS[tenant.type] ?? tenant.type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{tenant.memberCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {tenantBalanceText(tenant.balance)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(tenant.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 text-sm">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            上一页
          </Button>
          <span className="text-muted-foreground">第 {page} 页</span>
          <Button
            size="sm"
            variant="outline"
            disabled={tenants.length < PAGE_SIZE}
            onClick={() => setPage((current) => current + 1)}
          >
            下一页
          </Button>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>开户</DialogTitle>
            <DialogDescription>
              创建前台登录账户、用户与其同名个人专属租户（计费账户零余额）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="front-user-username">用户名</Label>
              <Input
                id="front-user-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="2-20 个字符"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="front-user-password">初始密码</Label>
              <Input
                id="front-user-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 6 位"
                autoComplete="new-password"
              />
            </div>
          </div>
          {formError && (
            <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {formError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button onClick={submitCreate} disabled={creating}>
              {creating ? '开户中...' : '确认开户'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={teamOpen} onOpenChange={setTeamOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建团队租户</DialogTitle>
            <DialogDescription>
              创建团队租户并自动开通全局工作区与零余额租户计费账户；创建后可在租户详情添加成员。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="team-tenant-name">租户名称</Label>
              <Input
                id="team-tenant-name"
                value={teamName}
                onChange={(event) => setTeamName(event.target.value)}
                placeholder="1-60 个字符"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          {teamError && (
            <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {teamError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTeamOpen(false)} disabled={creatingTeam}>
              取消
            </Button>
            <Button onClick={submitTeam} disabled={creatingTeam}>
              {creatingTeam ? '创建中...' : '确认创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
