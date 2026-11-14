import { useEffect, useState } from 'react'
import { gql } from '@apollo/client'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QueryError } from '@/components/ui/query-error'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

export const OIDC_PROVIDERS_QUERY = gql`
  query OidcProviders {
    oidcProviders {
      id
      type
      displayName
      issuer
      clientId
      scopes
      enabled
      enableFrontLogin
      enableAdminLogin
      hasSecret
      createdAt
      updatedAt
    }
  }
`

export const GITHUB_OAUTH_CONFIG_QUERY = gql`
  query GithubOauthConfig {
    githubOauthConfig {
      id
      type
      clientId
      enabled
      enableFrontLogin
      enableAdminLogin
      hasSecret
      callbackUrl
      createdAt
      updatedAt
    }
  }
`

const CREATE_OIDC_PROVIDER = gql`
  mutation CreateOidcProvider($input: OidcProviderInput!) {
    createOidcProvider(input: $input) {
      id
    }
  }
`

const UPDATE_OIDC_PROVIDER = gql`
  mutation UpdateOidcProvider($id: ID!, $input: OidcProviderInput!) {
    updateOidcProvider(id: $id, input: $input) {
      id
    }
  }
`

const DELETE_OIDC_PROVIDER = gql`
  mutation DeleteOidcProvider($id: ID!) {
    deleteOidcProvider(id: $id)
  }
`

const UPSERT_GITHUB_CONFIG = gql`
  mutation UpsertGithubOauthConfig($input: GithubOauthInput!) {
    upsertGithubOauthConfig(input: $input) {
      id
    }
  }
`

interface OidcProviderData {
  id: string
  displayName: string
  issuer: string
  clientId: string
  scopes: string
  enabled: boolean
  enableFrontLogin: boolean
  enableAdminLogin: boolean
  hasSecret: boolean
}

interface GithubConfigData {
  id: string
  clientId: string
  enabled: boolean
  enableFrontLogin: boolean
  enableAdminLogin: boolean
  hasSecret: boolean
  callbackUrl: string
}

interface ProviderForm {
  displayName: string
  issuer: string
  clientId: string
  clientSecret: string
  scopes: string
  enabled: boolean
  enableFrontLogin: boolean
  enableAdminLogin: boolean
}

const EMPTY_FORM: ProviderForm = {
  displayName: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  enabled: false,
  enableFrontLogin: true,
  enableAdminLogin: false,
}

function CopyableCallback({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{value}</code>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => toast.success('已复制'),
            () => toast.error('复制失败'),
          )
        }}
      >
        复制
      </Button>
    </div>
  )
}

function SurfaceBadges({ front, admin }: { front: boolean; admin: boolean }) {
  return (
    <span className="text-xs text-muted-foreground">
      {front ? '前台' : ''}
      {front && admin ? ' / ' : ''}
      {admin ? '后台' : ''}
    </span>
  )
}

export default function AuthProvidersPage() {
  const providersQuery = useQuery<{ oidcProviders: OidcProviderData[] }>(OIDC_PROVIDERS_QUERY)
  const githubQuery = useQuery<{ githubOauthConfig: GithubConfigData | null }>(GITHUB_OAUTH_CONFIG_QUERY)
  const [createProvider] = useMutation(CREATE_OIDC_PROVIDER, {
    refetchQueries: [OIDC_PROVIDERS_QUERY],
  })
  const [updateProvider] = useMutation(UPDATE_OIDC_PROVIDER, {
    refetchQueries: [OIDC_PROVIDERS_QUERY],
  })
  const [deleteProvider] = useMutation(DELETE_OIDC_PROVIDER, {
    refetchQueries: [OIDC_PROVIDERS_QUERY],
  })
  const [upsertGithub] = useMutation(UPSERT_GITHUB_CONFIG, {
    refetchQueries: [GITHUB_OAUTH_CONFIG_QUERY],
  })

  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<OidcProviderData | null>(null)

  const [githubForm, setGithubForm] = useState({
    clientId: '',
    clientSecret: '',
    enabled: false,
    enableFrontLogin: true,
    enableAdminLogin: false,
  })

  const providers = providersQuery.data?.oidcProviders ?? []
  const github = githubQuery.data?.githubOauthConfig ?? null

  useEffect(() => {
    if (github) {
      setGithubForm({
        clientId: github.clientId,
        clientSecret: '',
        enabled: github.enabled,
        enableFrontLogin: github.enableFrontLogin,
        enableAdminLogin: github.enableAdminLogin,
      })
    }
  }, [github])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const openEdit = (provider: OidcProviderData) => {
    setEditingId(provider.id)
    setForm({
      displayName: provider.displayName,
      issuer: provider.issuer,
      clientId: provider.clientId,
      // secret 仅写入不回显：编辑恒空占位，留空 = 不变
      clientSecret: '',
      scopes: provider.scopes,
      enabled: provider.enabled,
      enableFrontLogin: provider.enableFrontLogin,
      enableAdminLogin: provider.enableAdminLogin,
    })
    setFormOpen(true)
  }

  const submitProvider = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const input: Record<string, unknown> = {
        displayName: form.displayName,
        issuer: form.issuer,
        clientId: form.clientId,
        scopes: form.scopes,
        enabled: form.enabled,
        enableFrontLogin: form.enableFrontLogin,
        enableAdminLogin: form.enableAdminLogin,
      }
      if (form.clientSecret) input.clientSecret = form.clientSecret
      if (editingId) {
        await updateProvider({ variables: { id: editingId, input } })
        toast.success('OIDC Provider 已更新')
      } else {
        await createProvider({ variables: { input } })
        toast.success('OIDC Provider 已创建')
      }
      setFormOpen(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submitGithub = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const input: Record<string, unknown> = {
        enabled: githubForm.enabled,
        enableFrontLogin: githubForm.enableFrontLogin,
        enableAdminLogin: githubForm.enableAdminLogin,
      }
      if (githubForm.clientId) input.clientId = githubForm.clientId
      if (githubForm.clientSecret) input.clientSecret = githubForm.clientSecret
      await upsertGithub({ variables: { input } })
      toast.success('GitHub OAuth 配置已保存')
      setGithubForm((prev) => ({ ...prev, clientSecret: '' }))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (providersQuery.error && !providersQuery.data) {
    return (
      <QueryError
        message={providersQuery.error.message}
        onRetry={() => void providersQuery.refetch()}
      />
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">登录认证</h1>
          <p className="text-sm text-muted-foreground">
            配置自定义 OIDC Provider 与 GitHub OAuth；仅启用的方式会出现在前台/后台登录页。
          </p>
        </div>
        <Button onClick={openCreate}>新增 OIDC Provider</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">OIDC Provider</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚未配置 OIDC Provider。</p>
          ) : (
            providers.map((provider) => (
              <div
                key={provider.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{provider.displayName}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        provider.enabled
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {provider.enabled ? '已启用' : '已停用'}
                    </span>
                    <SurfaceBadges front={provider.enableFrontLogin} admin={provider.enableAdminLogin} />
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{provider.issuer}</p>
                  <p className="text-xs text-muted-foreground">
                    Client ID: {provider.clientId} · Secret: {provider.hasSecret ? '已设置' : '未设置'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => openEdit(provider)}>
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost-danger"
                    onClick={() => setDeleting(provider)}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">GitHub OAuth</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitGithub} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="gh-client-id">Client ID</Label>
              <Input
                id="gh-client-id"
                value={githubForm.clientId}
                onChange={(e) => setGithubForm({ ...githubForm, clientId: e.target.value })}
                placeholder={github ? '留空保持不变' : 'GitHub OAuth App Client ID'}
            />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gh-client-secret">Client Secret</Label>
              <Input
                id="gh-client-secret"
                type="password"
                value={githubForm.clientSecret}
                onChange={(e) => setGithubForm({ ...githubForm, clientSecret: e.target.value })}
                placeholder={github?.hasSecret ? '已设置（留空保持不变）' : 'Client Secret'}
              />
            </div>
            {github && (
              <div className="space-y-1">
                <Label>回调地址</Label>
                <CopyableCallback value={github.callbackUrl} />
              </div>
            )}
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={githubForm.enabled}
                  onChange={(e) => setGithubForm({ ...githubForm, enabled: e.target.checked })}
                />
                启用
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={githubForm.enableFrontLogin}
                  onChange={(e) => setGithubForm({ ...githubForm, enableFrontLogin: e.target.checked })}
                />
                前台登录
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={githubForm.enableAdminLogin}
                  onChange={(e) => setGithubForm({ ...githubForm, enableAdminLogin: e.target.checked })}
                />
                后台登录
              </label>
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? '保存中…' : '保存 GitHub 配置'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-lg">
            <CardHeader>
              <CardTitle className="text-base">
                {editingId ? '编辑 OIDC Provider' : '新增 OIDC Provider'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={submitProvider} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="oidc-name">显示名称</Label>
                  <Input
                    id="oidc-name"
                    value={form.displayName}
                    onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-issuer">Issuer</Label>
                  <Input
                    id="oidc-issuer"
                    value={form.issuer}
                    onChange={(e) => setForm({ ...form, issuer: e.target.value })}
                    placeholder="https://idp.example.com"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-client-id">Client ID</Label>
                  <Input
                    id="oidc-client-id"
                    value={form.clientId}
                    onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-secret">Client Secret</Label>
                  <Input
                    id="oidc-secret"
                    type="password"
                    value={form.clientSecret}
                    onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                    placeholder={editingId ? '已设置（留空保持不变）' : ''}
                    required={!editingId}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-scopes">Scopes</Label>
                  <Input
                    id="oidc-scopes"
                    value={form.scopes}
                    onChange={(e) => setForm({ ...form, scopes: e.target.value })}
                  />
                </div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    />
                    启用
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.enableFrontLogin}
                      onChange={(e) => setForm({ ...form, enableFrontLogin: e.target.checked })}
                    />
                    前台登录
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.enableAdminLogin}
                      onChange={(e) => setForm({ ...form, enableAdminLogin: e.target.checked })}
                    />
                    后台登录
                  </label>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                    取消
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {busy ? '保存中…' : '保存'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title="删除 OIDC Provider"
        description={`确认删除「${deleting?.displayName ?? ''}」？已绑定的外部身份将无法再使用该方式登录。`}
        confirmLabel="删除"
        onConfirm={async () => {
          if (!deleting) return
          try {
            await deleteProvider({ variables: { id: deleting.id } })
            toast.success('已删除')
          } catch (err) {
            toast.error((err as Error).message)
          } finally {
            setDeleting(null)
          }
        }}
      />
    </div>
  )
}
