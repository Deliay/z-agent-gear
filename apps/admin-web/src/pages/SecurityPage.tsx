import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { adminBindAuthorizeUrl } from '@/lib/auth-oauth'
import {
  ADMIN_EXTERNAL_LOGINS,
  ADMIN_AUTH_PROVIDERS,
  CREATE_ADMIN_BIND_TICKET,
  UNBIND_ADMIN_EXTERNAL_LOGIN,
} from '@/graphql/auth-providers'

interface Binding {
  id: string
  providerId: string
  providerDisplayName: string
  externalUsername: string
  createdAt: string
}

interface ProviderInfo {
  id: string
  type: string
  displayName: string
}

/** 账号安全：管理员外部身份绑定管理（绑定 / 解绑）。 */
export default function SecurityPage() {
  const [searchParams] = useSearchParams()
  const bindingsQuery = useQuery<{ adminExternalLogins: Binding[] }>(ADMIN_EXTERNAL_LOGINS)
  const providersQuery = useQuery<{ adminAuthProviders: ProviderInfo[] }>(ADMIN_AUTH_PROVIDERS)
  const [createTicket, { loading: binding }] = useMutation<{ createAdminBindTicket: string }>(
    CREATE_ADMIN_BIND_TICKET,
  )
  const [unbind] = useMutation(UNBIND_ADMIN_EXTERNAL_LOGIN, {
    refetchQueries: [ADMIN_EXTERNAL_LOGINS],
  })
  const [unbinding, setUnbinding] = useState<Binding | null>(null)

  const bindings = bindingsQuery.data?.adminExternalLogins ?? []
  const providers = providersQuery.data?.adminAuthProviders ?? []

  const bindResult = searchParams.get('bind')
  const bindError = searchParams.get('error')
  useEffect(() => {
    if (bindResult === 'success') {
      toast.success('外部身份绑定成功')
    } else if (bindResult === 'error') {
      toast.error(bindError ? `绑定失败：${bindError}` : '绑定失败')
    }
  }, [bindResult, bindError])

  const handleBind = async (providerId: string) => {
    try {
      const result = await createTicket({ variables: { providerId } })
      const ticket = result.data?.createAdminBindTicket
      if (!ticket) throw new Error('无法创建绑定票据')
      window.location.href = adminBindAuthorizeUrl(providerId, ticket)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const boundProviderIds = new Set(bindings.map((binding) => binding.providerId))
  const bindable = providers.filter((provider) => !boundProviderIds.has(provider.id))

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">账号安全</h1>
        <p className="text-sm text-muted-foreground">
          绑定外部身份后，方可使用对应的第三方登录方式进入管理后台。未绑定的身份一律拒绝登录。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">已绑定身份</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {bindings.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未绑定任何外部身份。</p>
          ) : (
            bindings.map((binding) => (
              <div
                key={binding.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {binding.providerDisplayName} · {binding.externalUsername}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    绑定时间：{new Date(binding.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button size="sm" variant="ghost-danger" onClick={() => setUnbinding(binding)}>
                  解绑
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">绑定新的外部身份</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {bindable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无可绑定的登录方式（请先在「登录认证」启用并允许后台登录）。
            </p>
          ) : (
            bindable.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <span className="text-sm">
                  {provider.type === 'github_oauth' ? 'GitHub' : provider.displayName}
                </span>
                <Button size="sm" disabled={binding} onClick={() => handleBind(provider.id)}>
                  {binding ? '跳转中…' : '绑定'}
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={unbinding !== null}
        onOpenChange={(open) => {
          if (!open) setUnbinding(null)
        }}
        title="解绑外部身份"
        description={`确认解绑「${unbinding?.externalUsername ?? ''}」？解绑后将无法再使用该身份登录后台。`}
        confirmLabel="解绑"
        onConfirm={async () => {
          if (!unbinding) return
          try {
            await unbind({ variables: { id: unbinding.id } })
            toast.success('已解绑')
          } catch (err) {
            toast.error((err as Error).message)
          } finally {
            setUnbinding(null)
          }
        }}
      />
    </div>
  )
}
