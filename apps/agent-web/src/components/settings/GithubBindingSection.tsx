import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { GET_GITHUB_ACCOUNTS, GET_GITHUB_APP_URL } from '@/graphql/queries'
import { UNBIND_GITHUB_ACCOUNT } from '@/graphql/mutations'
import type { GetGithubAccountsQuery, GetGithubAppUrlQuery } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import GithubAccountCard from './GithubAccountCard'
import UnbindConfirmDialog from './UnbindConfirmDialog'
import { useResourceSourceResolver } from '@/hooks/useResourceSource'
import { useWorkspaceAccess } from '@/stores/workspace'

export default function GithubBindingSection() {
  const { data, loading } = useQuery<GetGithubAccountsQuery>(GET_GITHUB_ACCOUNTS)
  const { data: appUrlData } = useQuery<GetGithubAppUrlQuery>(GET_GITHUB_APP_URL)
  const { readOnly: contextReadOnly } = useWorkspaceAccess()
  const resolveSource = useResourceSourceResolver()
  const [unbindAccount] = useMutation(UNBIND_GITHUB_ACCOUNT)
  const [searchParams, setSearchParams] = useSearchParams()

  const [unbindTarget, setUnbindTarget] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    const binding = searchParams.get('binding')
    if (binding === 'success') {
      setToast({ type: 'success', message: 'GitHub 帐号绑定成功' })
      const next = new URLSearchParams(searchParams)
      next.delete('binding')
      setSearchParams(next, { replace: true })
    } else if (binding === 'error') {
      const message = searchParams.get('message') || '绑定失败'
      setToast({ type: 'error', message: `GitHub 绑定失败: ${message}` })
      const next = new URLSearchParams(searchParams)
      next.delete('binding')
      next.delete('message')
      setSearchParams(next, { replace: true })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  const accounts = data?.githubAccounts ?? []

  const handleBind = () => {
    if (appUrlData?.githubAppUrl.url) {
      window.open(appUrlData.githubAppUrl.url, '_blank')
    }
  }

  const handleUnbind = async () => {
    if (!unbindTarget) return
    await unbindAccount({
      variables: { accountId: unbindTarget },
      refetchQueries: [GET_GITHUB_ACCOUNTS],
    })
    setUnbindTarget(null)
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>
  }

  return (
    <section className="space-y-4">
      {toast && (
        <div
          className={`rounded-md px-4 py-3 text-sm ${
            toast.type === 'success'
              ? 'bg-success/10 text-success'
              : 'bg-destructive/10 text-destructive'
          }`}
        >
          {toast.message}
        </div>
      )}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">GitHub 绑定</h3>
        {contextReadOnly ? (
          <span className="text-xs text-muted-foreground">全局工作区对开发者只读</span>
        ) : (
          <Button size="sm" onClick={handleBind} disabled={!appUrlData?.githubAppUrl?.url}>
            绑定 GitHub 帐号
          </Button>
        )}
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无绑定 GitHub 帐号
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map(account => (
            <GithubAccountCard
              key={account.id}
              account={account}
              onUnbind={(id) => setUnbindTarget(id)}
              readOnly={contextReadOnly || !resolveSource(account.workspaceId).editable}
              source={resolveSource(account.workspaceId)}
            />
          ))}
        </div>
      )}

      <UnbindConfirmDialog
        open={unbindTarget !== null}
        onOpenChange={(open) => { if (!open) setUnbindTarget(null) }}
        onConfirm={handleUnbind}
      />
    </section>
  )
}
