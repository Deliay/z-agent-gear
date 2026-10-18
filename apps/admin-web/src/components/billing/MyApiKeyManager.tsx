import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { CREATE_BILLING_API_KEY, REVOKE_BILLING_API_KEY } from '@/graphql/mutations'
import { ADMIN_BILLING_API_KEYS } from '@/graphql/queries'
import type { GetAdminBillingApiKeysQuery } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { formatDateTime } from '@/lib/format'

export default function MyApiKeyManager() {
  const { data, refetch } = useQuery<GetAdminBillingApiKeysQuery>(ADMIN_BILLING_API_KEYS)
  const [createKey, { loading: creating }] = useMutation(CREATE_BILLING_API_KEY)
  const [revokeKey] = useMutation(REVOKE_BILLING_API_KEY)
  const [name, setName] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)

  const create = async () => {
    if (!name.trim()) {
      toast.error('请输入 Key 名称')
      return
    }
    try {
      const result = await createKey({ variables: { name: name.trim() } })
      const payload = (result.data as { createBillingApiKey: { secret: string } } | undefined)
        ?.createBillingApiKey
      setSecret(payload?.secret ?? null)
      setName('')
      await refetch()
      toast.success('API Key 已生成（关闭后不可再查看完整值）')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败')
    }
  }

  const revoke = async () => {
    const id = revokeTarget
    setRevokeTarget(null)
    if (!id) return
    try {
      await revokeKey({ variables: { id } })
      await refetch()
      toast.success('API Key 已吊销')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '吊销失败')
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Key 名称" />
        <Button onClick={create} disabled={creating}>
          生成
        </Button>
      </div>
      {secret && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <div className="mb-1 font-medium">完整 Key 仅显示一次，请立即保存：</div>
          <code className="break-all">{secret}</code>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setSecret(null)}>
            我已保存
          </Button>
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 pr-3 font-medium">名称</th>
            <th className="py-2 pr-3 font-medium">前缀</th>
            <th className="py-2 pr-3 font-medium">状态</th>
            <th className="py-2 pr-3 font-medium">最后使用</th>
            <th className="py-2 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {(data?.adminBillingApiKeys ?? []).map((key) => (
            <tr key={key.id} className="border-b last:border-0">
              <td className="py-2 pr-3">{key.name}</td>
              <td className="py-2 pr-3 font-mono text-xs">{key.keyPrefix}…</td>
              <td className="py-2 pr-3">{key.status === 'active' ? '有效' : '已吊销'}</td>
              <td className="py-2 pr-3 text-xs text-muted-foreground">{formatDateTime(key.lastUsedAt)}</td>
              <td className="py-2">
                {key.status === 'active' && (
                  <Button size="sm" variant="outline" onClick={() => setRevokeTarget(key.id)}>
                    吊销
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="吊销 API Key"
        description="吊销后立即失效且不可恢复，确认继续？"
        confirmLabel="吊销"
        onConfirm={revoke}
      />
    </div>
  )
}
