import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  ADMIN_BILLING_ACCOUNTS,
  ADMIN_BILLING_API_CALLS,
  ADMIN_BILLING_INVOICES,
  ADMIN_BILLING_RECEIPTS,
  ADMIN_BILLING_ROLLUPS,
} from '@/graphql/queries'
import {
  RECONCILE_BILLING_ACCOUNT,
  SET_BILLING_ACCOUNT_CREDIT_LIMIT,
  SET_BILLING_ACCOUNT_STATUS,
} from '@/graphql/mutations'
import type {
  BillingAccountData,
  BillingInvoiceData,
  BillingRollupGranularity,
  GetAdminBillingAccountsQuery,
  GetAdminBillingApiCallsQuery,
  GetAdminBillingInvoicesQuery,
  GetAdminBillingReceiptsQuery,
  GetAdminBillingRollupsQuery,
} from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { QueryError } from '@/components/ui/query-error'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import AccountTable from '@/components/billing/AccountTable'
import RechargeDialog from '@/components/billing/RechargeDialog'
import InvoiceTable from '@/components/billing/InvoiceTable'
import ReceiptDrawer from '@/components/billing/ReceiptDrawer'
import RollupChart from '@/components/billing/RollupChart'
import MyApiKeyManager from '@/components/billing/MyApiKeyManager'
import { formatDateTime } from '@/lib/format'

function defaultRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

export default function BillingPage() {
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<BillingAccountData | null>(null)
  const [rechargeTarget, setRechargeTarget] = useState<BillingAccountData | null>(null)
  const [granularity, setGranularity] = useState<BillingRollupGranularity>('hour')
  const [range] = useState(defaultRange)
  const [creditLimit, setCreditLimit] = useState('')
  const [receiptInvoice, setReceiptInvoice] = useState<BillingInvoiceData | null>(null)
  const [page, setPage] = useState(1)
  const [invoicePage, setInvoicePage] = useState(1)
  const [callPage, setCallPage] = useState(1)
  const [confirmAction, setConfirmAction] = useState<'limit' | 'status' | null>(null)
  const pageSize = 20

  const accountsQuery = useQuery<GetAdminBillingAccountsQuery>(ADMIN_BILLING_ACCOUNTS, {
    variables: { keyword: keyword || null, page, pageSize },
  })
  const invoicesQuery = useQuery<GetAdminBillingInvoicesQuery>(ADMIN_BILLING_INVOICES, {
    variables: { accountId: selected?.id ?? '', page: invoicePage, pageSize },
    skip: !selected,
  })
  const receiptsQuery = useQuery<GetAdminBillingReceiptsQuery>(ADMIN_BILLING_RECEIPTS, {
    variables: { accountId: selected?.id ?? '', page: invoicePage, pageSize },
    skip: !selected,
  })
  const callsQuery = useQuery<GetAdminBillingApiCallsQuery>(ADMIN_BILLING_API_CALLS, {
    variables: { accountId: selected?.id ?? '', page: callPage, pageSize },
    skip: !selected,
  })
  const rollupsQuery = useQuery<GetAdminBillingRollupsQuery>(ADMIN_BILLING_ROLLUPS, {
    variables: {
      accountId: selected?.id ?? '',
      granularity,
      from: range.from,
      to: range.to,
    },
    skip: !selected,
  })

  const [updateCreditLimit] = useMutation(SET_BILLING_ACCOUNT_CREDIT_LIMIT)
  const [setStatus] = useMutation(SET_BILLING_ACCOUNT_STATUS)
  const [reconcile] = useMutation(RECONCILE_BILLING_ACCOUNT)

  const accounts = useMemo(() => accountsQuery.data?.adminBillingAccounts ?? [], [accountsQuery.data])
  const invoices = useMemo(() => invoicesQuery.data?.adminBillingInvoices ?? [], [invoicesQuery.data])
  const receipts = useMemo(() => receiptsQuery.data?.adminBillingReceipts ?? [], [receiptsQuery.data])
  const rollups = useMemo(() => rollupsQuery.data?.adminBillingRollups ?? [], [rollupsQuery.data])
  const calls = useMemo(() => callsQuery.data?.adminBillingApiCalls ?? [], [callsQuery.data])
  const receipt = receipts.find((item) => item.invoiceId === receiptInvoice?.id) ?? null

  const selectAccount = (account: BillingAccountData) => {
    setSelected(account)
    setCreditLimit(String(account.creditLimit))
    setInvoicePage(1)
    setCallPage(1)
  }

  const applyCreditLimit = async () => {
    setConfirmAction(null)
    if (!selected) return
    const value = Number(creditLimit)
    if (!Number.isFinite(value) || value < 0) {
      toast.error('授信额度不能为负数')
      return
    }
    try {
      await updateCreditLimit({ variables: { accountId: selected.id, creditLimit: value } })
      await accountsQuery.refetch()
      toast.success('授信额度已更新')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败')
    }
  }

  const toggleStatus = async () => {
    setConfirmAction(null)
    if (!selected) return
    const next = selected.status === 'frozen' ? 'active' : 'frozen'
    try {
      await setStatus({ variables: { accountId: selected.id, status: next } })
      await accountsQuery.refetch()
      toast.success(next === 'frozen' ? '账户已冻结' : '账户已恢复')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败')
    }
  }

  const runReconcile = async () => {
    if (!selected) return
    try {
      const result = await reconcile({ variables: { accountId: selected.id } })
      const account = (result.data as { reconcileBillingAccount?: BillingAccountData } | undefined)
        ?.reconcileBillingAccount
      await accountsQuery.refetch()
      toast.success(`精确核算完成，现金余额 ${account?.cashBalance.toFixed(2) ?? '-'}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '核算失败')
    }
  }

  if (accountsQuery.error && !accountsQuery.data) {
    return <QueryError message={accountsQuery.error.message} onRetry={() => void accountsQuery.refetch()} />
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="font-heading text-xl font-medium text-foreground">费用中心</h1>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>账户</CardTitle>
          <Input
            className="max-w-xs"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="按用户名 / 账户 ID 检索"
          />
        </CardHeader>
        <CardContent>
          {accountsQuery.loading && !accountsQuery.data ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <>
              <AccountTable
                accounts={accounts}
                selectedId={selected?.id ?? null}
                onSelect={selectAccount}
                onRecharge={(account) => setRechargeTarget(account)}
              />
              <div className="mt-3 flex items-center justify-end gap-2 text-sm">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  上一页
                </Button>
                <span className="text-muted-foreground">第 {page} 页</span>
                <Button size="sm" variant="outline" disabled={accounts.length < pageSize} onClick={() => setPage((p) => p + 1)}>
                  下一页
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selected && (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{selected.ownerName} 的账户</CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setRechargeTarget(selected)}>
                  充值
                </Button>
                <Button size="sm" variant="outline" onClick={runReconcile}>
                  精确核算
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmAction('status')}>
                  {selected.status === 'frozen' ? '恢复账户' : '冻结账户'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
                <div>
                  <div className="text-muted-foreground">可用余额</div>
                  <div className={selected.availableBalance < 0 ? 'text-destructive' : ''}>
                    {selected.availableBalance.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">现金</div>
                  <div>{selected.cashBalance.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">冻结</div>
                  <div>{selected.frozenAmount.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">授信额度</div>
                  <div>{selected.creditLimit.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">资金流水</div>
                  <div>{selected.ledgerCount} 笔</div>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <label className="block max-w-xs flex-1 space-y-1 text-sm">
                  <span>调整授信额度</span>
                  <Input
                    value={creditLimit}
                    onChange={(event) => setCreditLimit(event.target.value)}
                    placeholder="例如 100.00"
                  />
                </label>
                <Button size="sm" onClick={() => setConfirmAction('limit')}>
                  保存
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>账单明细</CardTitle>
            </CardHeader>
            <CardContent>
              {invoicesQuery.loading && !invoicesQuery.data ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : (
                <>
                  <InvoiceTable invoices={invoices} onViewReceipt={setReceiptInvoice} />
                  <div className="mt-3 flex items-center justify-end gap-2 text-sm">
                    <Button size="sm" variant="outline" disabled={invoicePage <= 1} onClick={() => setInvoicePage((p) => Math.max(1, p - 1))}>
                      上一页
                    </Button>
                    <span className="text-muted-foreground">第 {invoicePage} 页</span>
                    <Button size="sm" variant="outline" disabled={invoices.length < pageSize} onClick={() => setInvoicePage((p) => p + 1)}>
                      下一页
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>模型调用记录</CardTitle>
            </CardHeader>
            <CardContent>
              {calls.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无调用记录</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">时间</th>
                        <th className="py-2 pr-3 font-medium">模型</th>
                        <th className="py-2 pr-3 font-medium">Request</th>
                        <th className="py-2 pr-3 text-right font-medium">输入/缓存/输出</th>
                        <th className="py-2 pr-3 text-right font-medium">费用</th>
                        <th className="py-2 font-medium">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {calls.map((call) => (
                        <tr key={call.id} className="border-b last:border-0">
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {formatDateTime(call.startedAt)}
                          </td>
                          <td className="py-2 pr-3">{call.modelName || call.modelId}</td>
                          <td className="py-2 pr-3 font-mono text-xs">{call.requestId.slice(0, 8)}…</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {call.inputTokens}/{call.cachedInputTokens}/{call.outputTokens}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{call.cost.toFixed(2)}</td>
                          <td className="py-2">
                            <Badge variant={call.status === 'aborted' ? 'destructive' : 'outline'}>
                              {call.status === 'aborted' ? '中断调用' : call.status === 'failed' ? '失败' : '完成'}
                              {call.estimated ? '（估算）' : ''}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-3 flex items-center justify-end gap-2 text-sm">
                <Button size="sm" variant="outline" disabled={callPage <= 1} onClick={() => setCallPage((p) => Math.max(1, p - 1))}>
                  上一页
                </Button>
                <span className="text-muted-foreground">第 {callPage} 页</span>
                <Button size="sm" variant="outline" disabled={calls.length < pageSize} onClick={() => setCallPage((p) => p + 1)}>
                  下一页
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>汇总（近 7 天）</CardTitle>
              <div className="flex gap-1">
                {(['minute', 'hour', 'day'] as const).map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={granularity === item ? 'default' : 'outline'}
                    onClick={() => setGranularity(item)}
                  >
                    {item === 'minute' ? '分钟' : item === 'hour' ? '小时' : '天'}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <RollupChart rollups={rollups} />
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>我的 API Key</CardTitle>
        </CardHeader>
        <CardContent>
          <MyApiKeyManager />
        </CardContent>
      </Card>

      <RechargeDialog
        account={rechargeTarget}
        open={rechargeTarget !== null}
        onClose={() => setRechargeTarget(null)}
      />
      <ReceiptDrawer
        invoice={receiptInvoice}
        receipt={receipt}
        open={receiptInvoice !== null}
        onClose={() => setReceiptInvoice(null)}
      />
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={confirmAction === 'status' ? '变更账户状态' : '调整授信额度'}
        description={
          confirmAction === 'status'
            ? `确认${selected?.status === 'frozen' ? '恢复' : '冻结'}账户「${selected?.ownerName ?? ''}」？`
            : `确认把账户「${selected?.ownerName ?? ''}」的授信额度调整为 ${creditLimit || 0} credits？`
        }
        confirmLabel="确认"
        onConfirm={confirmAction === 'status' ? toggleStatus : applyCreditLimit}
      />
    </div>
  )
}
