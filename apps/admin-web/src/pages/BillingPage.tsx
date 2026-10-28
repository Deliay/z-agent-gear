import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ADMIN_BILLING_ACCOUNTS,
  ADMIN_BILLING_API_CALLS,
  ADMIN_BILLING_INVOICES,
  ADMIN_BILLING_RECEIPT,
  ADMIN_BILLING_ROLLUPS,
} from '@/graphql/queries'
import {
  RECONCILE_BILLING_ACCOUNT,
  SET_BILLING_ACCOUNT_CREDIT_LIMIT,
  SET_BILLING_ACCOUNT_STATUS,
} from '@/graphql/mutations'
import type {
  BillingAccountData,
  BillingCategory,
  BillingInvoiceData,
  BillingLedgerType,
  BillingOwnerType,
  BillingRollupGranularity,
  GetAdminBillingAccountsQuery,
  GetAdminBillingApiCallsQuery,
  GetAdminBillingInvoicesQuery,
  GetAdminBillingReceiptQuery,
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

function parseOwnerType(value: string | null): BillingOwnerType | '' {
  return value === 'admin_user' || value === 'tenant' || value === 'front_user' ? value : ''
}

export default function BillingPage() {
  // 租户详情页「充值」入口带 `ownerType=tenant&keyword=<tenantId>` 跳转：
  // 保持计费账户视角，仅预置检索条件并在账户加载后自动选中该租户计费账户。
  const [searchParams] = useSearchParams()
  const initialKeyword = searchParams.get('keyword') ?? ''
  const initialOwnerType = parseOwnerType(searchParams.get('ownerType'))
  const [keyword, setKeyword] = useState(initialKeyword)
  const [ownerType, setOwnerType] = useState<BillingOwnerType | ''>(initialOwnerType)
  // D-2：只保存 id，`selected` 由账户列表派生；mutation 后 refetch 即自动刷新，
  // 不会出现「点击时刻陈旧快照」导致连续冻结/恢复方向翻转。
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rechargeTarget, setRechargeTarget] = useState<BillingAccountData | null>(null)
  const [granularity, setGranularity] = useState<BillingRollupGranularity>('hour')
  const [range] = useState(defaultRange)
  const [creditLimit, setCreditLimit] = useState('')
  const [receiptInvoice, setReceiptInvoice] = useState<BillingInvoiceData | null>(null)
  const [page, setPage] = useState(1)
  const [invoicePage, setInvoicePage] = useState(1)
  const [callPage, setCallPage] = useState(1)
  // R10-7：PRD 功能点 7 的时间范围/类型/来源筛选。
  const [invoiceFrom, setInvoiceFrom] = useState('')
  const [invoiceTo, setInvoiceTo] = useState('')
  const [invoiceType, setInvoiceType] = useState<BillingLedgerType | ''>('')
  const [invoiceCategory, setInvoiceCategory] = useState<BillingCategory | ''>('')
  const [confirmAction, setConfirmAction] = useState<'limit' | 'status' | null>(null)
  const pageSize = 20

  const accountsQuery = useQuery<GetAdminBillingAccountsQuery>(ADMIN_BILLING_ACCOUNTS, {
    variables: { keyword: keyword || null, ownerType: ownerType || null, page, pageSize },
  })
  const invoicesQuery = useQuery<GetAdminBillingInvoicesQuery>(ADMIN_BILLING_INVOICES, {
    variables: {
      accountId: selectedId ?? '',
      from: invoiceFrom ? new Date(`${invoiceFrom}T00:00:00.000Z`).toISOString() : null,
      to: invoiceTo ? new Date(`${invoiceTo}T23:59:59.999Z`).toISOString() : null,
      type: invoiceType || null,
      category: invoiceCategory || null,
      page: invoicePage,
      pageSize,
    },
    skip: !selectedId,
  })
  // D-1：收据按账单直查（不再与账单分页 rank 耦合）。
  const receiptQuery = useQuery<GetAdminBillingReceiptQuery>(ADMIN_BILLING_RECEIPT, {
    variables: { invoiceId: receiptInvoice?.id ?? '' },
    skip: !receiptInvoice,
    fetchPolicy: 'cache-and-network',
  })
  const callsQuery = useQuery<GetAdminBillingApiCallsQuery>(ADMIN_BILLING_API_CALLS, {
    variables: { accountId: selectedId ?? '', page: callPage, pageSize },
    skip: !selectedId,
  })
  const rollupsQuery = useQuery<GetAdminBillingRollupsQuery>(ADMIN_BILLING_ROLLUPS, {
    variables: {
      accountId: selectedId ?? '',
      granularity,
      from: range.from,
      to: range.to,
    },
    skip: !selectedId,
  })

  const [updateCreditLimit] = useMutation(SET_BILLING_ACCOUNT_CREDIT_LIMIT)
  const [setStatus] = useMutation(SET_BILLING_ACCOUNT_STATUS)
  const [reconcile] = useMutation(RECONCILE_BILLING_ACCOUNT)

  const accounts = useMemo(() => accountsQuery.data?.adminBillingAccounts ?? [], [accountsQuery.data])
  const selected = useMemo(
    () => accounts.find((account) => account.id === selectedId) ?? null,
    [accounts, selectedId],
  )
  const invoices = useMemo(() => invoicesQuery.data?.adminBillingInvoices ?? [], [invoicesQuery.data])
  const receipt = receiptQuery.data?.adminBillingReceipt ?? null
  const rollups = useMemo(() => rollupsQuery.data?.adminBillingRollups ?? [], [rollupsQuery.data])
  const calls = useMemo(() => callsQuery.data?.adminBillingApiCalls ?? [], [callsQuery.data])

  // 选中账户数据刷新后同步输入框（仅在切换账户时初始化，避免覆盖正在编辑的值）。
  useEffect(() => {
    if (!selectedId) {
      setCreditLimit('')
      return
    }
    const current = accounts.find((account) => account.id === selectedId)
    if (current) setCreditLimit(String(current.creditLimit))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const selectAccount = (account: BillingAccountData) => {
    setSelectedId(account.id)
    setCreditLimit(String(account.creditLimit))
    setInvoicePage(1)
    setCallPage(1)
  }

  // 从租户详情页跳转而来时（带 keyword 且尚无选中账户），自动选中该租户计费账户
  // （keyword 为 tenantId，服务端按 ownerId 命中，ownerId 与 tenantId 同值）。
  useEffect(() => {
    if (!initialKeyword || selectedId) return
    const target = accounts.find((account) => account.ownerId === initialKeyword)
    if (!target) return
    setSelectedId(target.id)
    setCreditLimit(String(target.creditLimit))
    setInvoicePage(1)
    setCallPage(1)
  }, [initialKeyword, selectedId, accounts])

  const applyCreditLimit = async () => {
    setConfirmAction(null)
    if (!selected) return
    if (creditLimit.trim() === '') {
      toast.error('请输入授信额度')
      return
    }
    const value = Number(creditLimit)
    if (!Number.isFinite(value) || value < 0) {
      toast.error('授信额度不能为负数')
      return
    }
    try {
      const result = await updateCreditLimit({
        variables: { accountId: selected.id, creditLimit: value },
      })
      const updated = (result.data as { setBillingAccountCreditLimit?: BillingAccountData } | undefined)
        ?.setBillingAccountCreditLimit
      if (updated) setCreditLimit(String(updated.creditLimit))
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
      toast.success(next === 'frozen' ? '账户已冻结' : '账户已恢复')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败')
      return
    }
    // 🟡8：变更已成功，刷新失败不得反向误报为「更新失败」（否则用户会重试造成方向翻转）。
    try {
      await accountsQuery.refetch()
    } catch {
      toast.error('状态已更新，但列表刷新失败，请手动刷新')
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

  const onRechargeSuccess = () => {
    // D-4：充值成功后刷新账户与账单（此前只刷新账户，账单仍是旧列表）。
    void accountsQuery.refetch()
    if (selectedId) {
      void invoicesQuery.refetch()
      // 🟡8：收据查询用 `receiptInvoice?.id` 变量且 skip=!receiptInvoice，无选中时 refetch 会发空 invoiceId 必败请求。
      if (receiptInvoice) void receiptQuery.refetch()
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
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="账户类型"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={ownerType}
              onChange={(event) => {
                setOwnerType(event.target.value as BillingOwnerType | '')
                setPage(1)
              }}
            >
              <option value="">全部类型</option>
              <option value="tenant">租户（tenant）</option>
              <option value="admin_user">后台（admin_user）</option>
            </select>
            <Input
              className="max-w-xs"
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value)
                // 建议 19：搜索条件变化时重置页码，避免停留在旧范围的空页。
                setPage(1)
              }}
              placeholder="按账户名 / 账户 ID 检索"
            />
          </div>
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
              <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
                <label className="space-y-1">
                  <span className="block text-muted-foreground">开始日期</span>
                  <Input
                    type="date"
                    value={invoiceFrom}
                    onChange={(event) => {
                      setInvoiceFrom(event.target.value)
                      setInvoicePage(1)
                    }}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-muted-foreground">结束日期</span>
                  <Input
                    type="date"
                    value={invoiceTo}
                    onChange={(event) => {
                      setInvoiceTo(event.target.value)
                      setInvoicePage(1)
                    }}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-muted-foreground">类型</span>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={invoiceType}
                    onChange={(event) => {
                      setInvoiceType(event.target.value as BillingLedgerType | '')
                      setInvoicePage(1)
                    }}
                  >
                    <option value="">全部</option>
                    <option value="charge">消费</option>
                    <option value="recharge">充值</option>
                    <option value="adjust">调整</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-muted-foreground">来源</span>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={invoiceCategory}
                    onChange={(event) => {
                      setInvoiceCategory(event.target.value as BillingCategory | '')
                      setInvoicePage(1)
                    }}
                  >
                    <option value="">全部</option>
                    <option value="container">容器</option>
                    <option value="model">模型</option>
                    <option value="manual">手工</option>
                  </select>
                </label>
              </div>
              {invoicesQuery.loading && !invoicesQuery.data ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : invoicesQuery.error ? (
                <div className="space-y-2 text-sm text-destructive">
                  <p>账单加载失败：{invoicesQuery.error.message}</p>
                  <Button size="sm" variant="outline" onClick={() => void invoicesQuery.refetch()}>
                    重试
                  </Button>
                </div>
              ) : invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  暂无账单{invoicePage > 1 ? '（本页为空，可返回上一页）' : ''}
                </p>
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
              {callsQuery.loading && !callsQuery.data ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : callsQuery.error ? (
                <div className="space-y-2 text-sm text-destructive">
                  <p>调用记录加载失败：{callsQuery.error.message}</p>
                  <Button size="sm" variant="outline" onClick={() => void callsQuery.refetch()}>
                    重试
                  </Button>
                </div>
              ) : calls.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  暂无调用记录{callPage > 1 ? '（本页为空，可返回上一页）' : ''}
                </p>
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
                            <Badge
                              variant={
                                call.status === 'aborted' || call.status === 'failed'
                                  ? 'destructive'
                                  : 'outline'
                              }
                            >
                              {call.status === 'aborted'
                                ? '中断调用'
                                : call.status === 'failed'
                                  ? '失败'
                                  : call.status === 'started'
                                    ? '进行中/异常'
                                    : '完成'}
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
              {rollupsQuery.error ? (
                <div className="space-y-2 text-sm text-destructive">
                  <p>汇总加载失败：{rollupsQuery.error.message}</p>
                  <Button size="sm" variant="outline" onClick={() => void rollupsQuery.refetch()}>
                    重试
                  </Button>
                </div>
              ) : rollupsQuery.loading && !rollupsQuery.data ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : rollups.length === 0 ? (
                <p className="text-sm text-muted-foreground">区间内暂无计费汇总</p>
              ) : (
                <RollupChart rollups={rollups} />
              )}
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
        onSuccess={onRechargeSuccess}
      />
      <ReceiptDrawer
        invoice={receiptInvoice}
        receipt={receipt}
        loading={receiptQuery.loading}
        error={receiptQuery.error?.message ?? null}
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
