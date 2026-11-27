import type { BillingAccountData } from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/format'
import { statusBadgeProps } from '@/lib/status-labels'
import * as T from '@/lib/table-styles'

interface Props {
  accounts: BillingAccountData[]
  selectedId: string | null
  onSelect: (account: BillingAccountData) => void
  onRecharge: (account: BillingAccountData) => void
}

const OWNER_TYPE_LABELS: Record<string, string> = {
  admin_user: '后台',
  tenant: '租户',
  front_user: '前台',
}

export default function AccountTable({ accounts, selectedId, onSelect, onRecharge }: Props) {
  if (accounts.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无账户</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className={`${T.TABLE_CLASS} min-w-[720px]`}>
        <thead>
          <tr className={T.TABLE_HEAD_CLASS}>
            <th className={T.TABLE_HEAD_CELL_CLASS}>账户</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>类型</th>
            <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>可用余额</th>
            <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>现金</th>
            <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>冻结</th>
            <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>授信</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>状态</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>创建时间</th>
            <th className={T.TABLE_HEAD_CELL_ACTION_CLASS}>操作</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => {
            const negative = account.availableBalance < 0
            const status = statusBadgeProps(
              account.insufficientSince ? 'insufficient' : account.status,
            )
            return (
              <tr
                key={account.id}
                className={`cursor-pointer border-b last:border-0 hover:bg-muted/50 ${
                  selectedId === account.id ? 'bg-muted/50' : ''
                }`}
                onClick={() => onSelect(account)}
              >
                <td className={T.TABLE_CELL_CLASS}>
                  <div className="font-medium">{account.ownerName}</div>
                  <div className="text-xs text-muted-foreground">{account.ownerId}</div>
                </td>
                <td className={T.TABLE_CELL_CLASS}>{OWNER_TYPE_LABELS[account.ownerType] ?? account.ownerType}</td>
                <td className={`${T.TABLE_CELL_NUMERIC_CLASS} ${negative ? 'text-destructive' : ''}`}>
                  {account.availableBalance.toFixed(2)}
                </td>
                <td className={T.TABLE_CELL_NUMERIC_CLASS}>{account.cashBalance.toFixed(2)}</td>
                <td className={T.TABLE_CELL_NUMERIC_CLASS}>{account.frozenAmount.toFixed(2)}</td>
                <td className={T.TABLE_CELL_NUMERIC_CLASS}>{account.creditLimit.toFixed(2)}</td>
                <td className={T.TABLE_CELL_CLASS}>
                  {account.insufficientSince ? (
                    <Badge variant={status.variant}>
                      欠费 {formatDateTime(account.insufficientSince)}
                    </Badge>
                  ) : (
                    <Badge variant={status.variant}>{status.label}</Badge>
                  )}
                </td>
                <td className={T.TABLE_CELL_MUTED_CLASS}>
                  {formatDateTime(account.createdAt)}
                </td>
                <td className={T.TABLE_ACTION_CELL_CLASS}>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(event) => {
                      event.stopPropagation()
                      onRecharge(account)
                    }}
                  >
                    充值
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
