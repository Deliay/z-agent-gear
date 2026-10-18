import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  ADMIN_BILLING_ACCOUNTS,
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
  GetAdminBillingInvoicesQuery,
  GetAdminBillingReceiptsQuery,
  GetAdminBillingRollupsQuery,
} from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { QueryError } from '@/components/ui/query-error'
import AccountTable from '@/components/billing/AccountTable'
import RechargeDialog from '@/components/billing/RechargeDialog'
import InvoiceTable from '@/components/billing/InvoiceTable'
import ReceiptDrawer from '@/components/billing/ReceiptDrawer'
import RollupChart from '@/components/billing/RollupChart'
import MyApiKeyManager from '@/components/billing/MyApiKeyManager'
import ModelPricingSection from '@/components/billing/ModelPricingSection'

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

  const accountsQuery = useQuery<GetAdminBillingAccountsQuery>(ADMIN_BILLING_ACCOUNTS, {
    variables: { keyword: keyword || null, page: 1, pageSize: 100 },
  })
  const invoicesQuery = useQuery<GetAdminBillingInvoicesQuery>(ADMIN_BILLING_INVOICES, {
    variables: { accountId: selected?.id ?? '', page: 1, pageSize: 100 },
    skip: !selected,
  })
  const receiptsQuery = useQuery<GetAdminBillingReceiptsQuery>(ADMIN_BILLING_RECEIPTS, {
    variables: { accountId: selected?.id ?? '', page: 1, pageSize: 100 },
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
  const receipt = receipts.find((item) => item.invoiceId === receiptInvoice?.id) ?? null

  const selectAccount = (account: BillingAccountData) => {
    setSelected(account)
    setCreditLimit(String(account.creditLimit))
  }

  const applyCreditLimit = async () => {
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
            <AccountTable
              accounts={accounts}
              selectedId={selected?.id ?? null}
              onSelect={selectAccount}
              onRecharge={(account) => setRechargeTarget(account)}
            />
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
                <Button size="sm" variant="outline" onClick={toggleStatus}>
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
                <Button size="sm" onClick={applyCreditLimit}>
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
                <InvoiceTable invoices={invoices} onViewReceipt={setReceiptInvoice} />
              )}
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

      <ModelPricingSection />

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
    </div>
  )
}
