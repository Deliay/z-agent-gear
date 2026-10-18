import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  MY_BILLING_ACCOUNT,
  MY_BILLING_API_KEYS,
  MY_BILLING_INVOICES,
  MY_BILLING_RECEIPTS,
  MY_BILLING_ROLLUPS,
} from '@/graphql/queries'
import { CREATE_MY_BILLING_API_KEY, REVOKE_MY_BILLING_API_KEY } from '@/graphql/mutations'
import type {
  GetMyBillingAccountQuery,
  GetMyBillingApiKeysQuery,
  GetMyBillingInvoicesQuery,
  GetMyBillingReceiptsQuery,
  GetMyBillingRollupsQuery,
  MyBillingInvoiceData,
} from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatDateTime } from '@/lib/format'

export default function BillingPage() {
  const [granularity, setGranularity] = useState<'hour' | 'day'>('day')
  const range = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - (granularity === 'day' ? 30 : 7) * 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [granularity])

  const accountQuery = useQuery<GetMyBillingAccountQuery>(MY_BILLING_ACCOUNT)
  const invoicesQuery = useQuery<GetMyBillingInvoicesQuery>(MY_BILLING_INVOICES, {
    variables: { page: 1, pageSize: 100 },
  })
  const receiptsQuery = useQuery<GetMyBillingReceiptsQuery>(MY_BILLING_RECEIPTS, {
    variables: { page: 1, pageSize: 100 },
  })
  const rollupsQuery = useQuery<GetMyBillingRollupsQuery>(MY_BILLING_ROLLUPS, {
    variables: { granularity, from: range.from, to: range.to },
  })
  const keysQuery = useQuery<GetMyBillingApiKeysQuery>(MY_BILLING_API_KEYS)
  const [createKey, { loading: creating }] = useMutation(CREATE_MY_BILLING_API_KEY)
  const [revokeKey] = useMutation(REVOKE_MY_BILLING_API_KEY)

  const [name, setName] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [receiptInvoice, setReceiptInvoice] = useState<MyBillingInvoiceData | null>(null)

  const account = accountQuery.data?.myBillingAccount
  const invoices = invoicesQuery.data?.myBillingInvoices ?? []
  const receipts = receiptsQuery.data?.myBillingReceipts ?? []
  const rollups = rollupsQuery.data?.myBillingRollups ?? []
  const keys = keysQuery.data?.myBillingApiKeys ?? []
  const receipt = receipts.find((item) => item.invoiceId === receiptInvoice?.id) ?? null
  const maxRollup = Math.max(...rollups.map((item) => item.chargeTotal), 1)

  const create = async () => {
    if (!name.trim()) {
      toast.error('请输入 Key 名称')
      return
    }
    try {
      const result = await createKey({ variables: { name: name.trim() } })
      const payload = (result.data as { createMyBillingApiKey?: { secret: string } } | undefined)
        ?.createMyBillingApiKey
      setSecret(payload?.secret ?? null)
      setName('')
      await keysQuery.refetch()
      toast.success('API Key 已生成（仅显示一次）')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败')
    }
  }

  const revoke = async (id: string) => {
    try {
      await revokeKey({ variables: { id } })
      await keysQuery.refetch()
      toast.success('API Key 已吊销')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '吊销失败')
    }
  }

  return (
    <div className="container mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="font-heading text-xl font-medium">我的费用</h1>

      {accountQuery.error && !account ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            费用数据加载失败：{accountQuery.error.message}
          </CardContent>
        </Card>
      ) : (
        account && (
          <Card>
            <CardHeader>
              <CardTitle>账户</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {account.availableBalance < 0 && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  账户已欠费（可用余额 {account.availableBalance.toFixed(2)} credits），
                  请联系统管理员充值；持续欠费将导致云端容器被强制销毁。
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div>
                  <div className="text-muted-foreground">可用余额</div>
                  <div className={account.availableBalance < 0 ? 'text-destructive' : ''}>
                    {account.availableBalance.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">现金</div>
                  <div>{account.cashBalance.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">冻结</div>
                  <div>{account.frozenAmount.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">状态</div>
                  <div>{account.insufficientSince ? '欠费中' : '正常'}</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                仅支持后台充值，本页面不提供自助充值入口。
              </p>
            </CardContent>
          </Card>
        )
      )}

      <Card>
        <CardHeader>
          <CardTitle>账单明细</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无账单</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">序号</th>
                    <th className="py-2 pr-3 font-medium">时间</th>
                    <th className="py-2 pr-3 font-medium">来源</th>
                    <th className="py-2 pr-3 font-medium">描述</th>
                    <th className="py-2 pr-3 text-right font-medium">金额</th>
                    <th className="py-2 pr-3 text-right font-medium">余额</th>
                    <th className="py-2 font-medium">收据</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 tabular-nums">{invoice.seq}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {formatDateTime(invoice.createdAt)}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant="outline">
                          {invoice.category === 'container' ? '容器' : invoice.category === 'model' ? '模型' : '手工'}
                        </Badge>
                      </td>
                      <td className="max-w-[220px] truncate py-2 pr-3" title={invoice.description}>
                        {invoice.description}
                      </td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${invoice.amount < 0 ? 'text-destructive' : ''}`}>
                        {invoice.amount.toFixed(2)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{invoice.balanceAfter.toFixed(2)}</td>
                      <td className="py-2">
                        {invoice.type === 'charge' ? (
                          <Button size="sm" variant="ghost" onClick={() => setReceiptInvoice(invoice)}>
                            查看
                          </Button>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>消费汇总</CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant={granularity === 'hour' ? 'default' : 'outline'} onClick={() => setGranularity('hour')}>
              小时
            </Button>
            <Button size="sm" variant={granularity === 'day' ? 'default' : 'outline'} onClick={() => setGranularity('day')}>
              天
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {rollups.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无汇总数据</p>
          ) : (
            rollups.map((item) => (
              <div key={item.bucketStart} className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{formatDateTime(item.bucketStart)}</span>
                  <span>
                    消费 {item.chargeTotal.toFixed(2)} · {item.chargeCount} 笔
                  </span>
                </div>
                <div className="h-2 rounded bg-muted">
                  <div
                    className="h-2 rounded bg-primary/70"
                    style={{ width: `${(item.chargeTotal / maxRollup) * 100}%` }}
                  />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>我的 API Key</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
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
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无 API Key</p>
          ) : (
            <ul className="space-y-2">
              {keys.map((key) => (
                <li key={key.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {key.name} <span className="font-mono text-xs text-muted-foreground">{key.keyPrefix}…</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {key.status === 'active' ? '有效' : '已吊销'}
                    </span>
                    {key.status === 'active' && (
                      <Button size="sm" variant="outline" onClick={() => revoke(key.id)}>
                        吊销
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={receiptInvoice !== null} onOpenChange={(next) => !next && setReceiptInvoice(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>收据</DialogTitle>
            <DialogDescription>{receipt ? `收据号 ${receipt.receiptNo}` : '该账单暂无收据'}</DialogDescription>
          </DialogHeader>
          {receiptInvoice && (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">金额</span>
                <span>{receiptInvoice.amount.toFixed(2)} credits</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">支付后余额</span>
                <span>{receiptInvoice.balanceAfter.toFixed(2)} credits</span>
              </div>
              <div className="space-y-1 border-t pt-2">
                {receiptInvoice.items.map((item, index) => (
                  <div key={`${item.productId}-${index}`} className="flex justify-between text-xs">
                    <span>{item.productId}</span>
                    <span className="tabular-nums">
                      {item.quantity} × {item.unitPrice.toFixed(4)} = {item.amount.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
