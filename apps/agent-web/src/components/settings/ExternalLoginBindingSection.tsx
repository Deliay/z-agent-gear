import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import {
  GET_AUTH_PROVIDERS,
  GET_MY_EXTERNAL_LOGINS,
} from '@/graphql/queries'
import {
  CREATE_FRONT_BIND_TICKET,
  UNBIND_EXTERNAL_LOGIN,
} from '@/graphql/mutations'
import type {
  CreateFrontBindTicketMutation,
  GetAuthProvidersQuery,
  GetMyExternalLoginsQuery,
  UnbindExternalLoginMutation,
} from '@/graphql/types'
import { mapIdentityChoiceError, oauthAuthorizeUrl } from '@/lib/auth-oauth'
import { Button } from '@/components/ui/button'
import UnbindConfirmDialog from './UnbindConfirmDialog'

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

/**
 * 设置页「第三方登录绑定」（#510）：查看已绑定身份、手动绑定、解绑。
 *
 * - 绑定：`createFrontBindTicket` 取一次性票据 → `surface=front-bind` 授权 → 回设置页 `?bind=success`；
 * - 解绑：二次确认后调用 `unbindExternalLogin`，服务端强制「无密码账户最后一条不可解绑」。
 */
export default function ExternalLoginBindingSection() {
  const { data, loading } = useQuery<GetMyExternalLoginsQuery>(GET_MY_EXTERNAL_LOGINS, {
    fetchPolicy: 'cache-and-network',
  })
  const { data: providerData } = useQuery<GetAuthProvidersQuery>(GET_AUTH_PROVIDERS, {
    fetchPolicy: 'cache-and-network',
  })
  const [unbindTarget, setUnbindTarget] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [bindingProviderId, setBindingProviderId] = useState<string | null>(null)

  const [unbindExternalLogin] = useMutation<UnbindExternalLoginMutation>(
    UNBIND_EXTERNAL_LOGIN,
    {
      refetchQueries: [GET_MY_EXTERNAL_LOGINS],
      onError: (err: Error) => setError(mapIdentityChoiceError(err.message)),
      onCompleted: () => setError(''),
    },
  )

  const [createBindTicket] = useMutation<CreateFrontBindTicketMutation>(
    CREATE_FRONT_BIND_TICKET,
    {
      onError: (err: Error) => {
        setBindingProviderId(null)
        setError(mapIdentityChoiceError(err.message))
      },
    },
  )

  const bindings = data?.myExternalLogins ?? []
  const providers = providerData?.authProviders ?? []
  const boundProviderIds = new Set(bindings.map((item) => item.providerId))

  const handleBind = async (providerId: string) => {
    setError('')
    setBindingProviderId(providerId)
    try {
      const result = await createBindTicket({ variables: { providerId } })
      const ticket = result.data?.createFrontBindTicket
      if (!ticket) {
        setBindingProviderId(null)
        return
      }
      window.location.href = oauthAuthorizeUrl(providerId, 'front-bind', ticket)
    } catch {
      // onError 已展示文案
      setBindingProviderId(null)
    }
  }

  const handleUnbind = async () => {
    if (!unbindTarget) return
    try {
      await unbindExternalLogin({ variables: { id: unbindTarget } })
    } finally {
      setUnbindTarget(null)
    }
  }

  if (loading && !data) {
    return <div className="text-sm text-muted-foreground">加载中...</div>
  }

  // 未配置任何第三方登录方式且无绑定：设置页保持与升级前一致（不展示区块）
  if (providers.length === 0 && bindings.length === 0) return null

  return (
    <section className="space-y-4" data-testid="external-login-binding-section">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">第三方登录绑定</h3>
      </div>

      {error && (
        <div role="alert" className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {bindings.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无绑定第三方登录方式
        </div>
      ) : (
        <div className="space-y-2">
          {bindings.map((binding) => (
            <div
              key={binding.id}
              data-testid="external-login-row"
              className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">
                    {binding.providerDisplayName}
                  </span>
                  {!binding.providerEnabled && (
                    <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      已停用
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  外部帐号：{binding.externalUsername}
                </p>
                <p className="text-xs text-muted-foreground">
                  绑定时间：{formatTime(binding.createdAt)}
                  {binding.lastLoginAt
                    ? ` · 最近登录：${formatTime(binding.lastLoginAt)}`
                    : ''}
                </p>
              </div>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setUnbindTarget(binding.id)}
              >
                解绑
              </Button>
            </div>
          ))}
        </div>
      )}

      {providers.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-foreground">可绑定的登录方式</h4>
          {providers.map((provider) => {
            const bound = boundProviderIds.has(provider.id)
            const displayName =
              provider.type === 'github_oauth' ? 'GitHub' : provider.displayName
            return (
              <div
                key={provider.id}
                className="flex items-center justify-between rounded-lg border p-4"
              >
                <span className="text-sm text-foreground">{displayName}</span>
                {bound ? (
                  <span className="text-xs text-muted-foreground">已绑定</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bindingProviderId === provider.id}
                    onClick={() => handleBind(provider.id)}
                    aria-label={`绑定 ${displayName}`}
                  >
                    {bindingProviderId === provider.id ? '跳转中…' : '绑定'}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <UnbindConfirmDialog
        open={unbindTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnbindTarget(null)
        }}
        onConfirm={handleUnbind}
        title="确认解绑第三方登录"
        description="确定要解绑该第三方登录方式吗？解绑后该身份将无法再登录当前账户。"
      />
    </section>
  )
}
