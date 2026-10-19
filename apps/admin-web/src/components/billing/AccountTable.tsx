import type { BillingAccountData } from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/format'

interface Props {
  accounts: BillingAccountData[]
  selectedId: string | null
  onSelect: (account: BillingAccountData) => void
  onRecharge: (account: BillingAccountData) => void
}

export default function AccountTable({ accounts, selectedId, onSelect, onRecharge }: Props) {
  if (accounts.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无账户</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 pr-3 font-medium">账户</th>
            <th className="py-2 pr-3 font-medium">类型</th>
            <th className="py-2 pr-3 text-right font-medium">可用余额</th>
            <th className="py-2 pr-3 text-right font-medium">现金</th>
            <th className="py-2 pr-3 text-right font-medium">冻结</th>
            <th className="py-2 pr-3 text-right font-medium">授信</th>
            <th className="py-2 pr-3 font-medium">状态</th>
            <th className="py-2 pr-3 font-medium">创建时间</th>
            <th className="py-2 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => {
            const negative = account.availableBalance < 0
            return (
              <tr
                key={account.id}
                className={`cursor-pointer border-b last:border-0 hover:bg-muted/50 ${
                  selectedId === account.id ? 'bg-muted/50' : ''
                }`}
                onClick={() => onSelect(account)}
              >
                <td className="py-2 pr-3">
                  <div className="font-medium">{account.ownerName}</div>
                  <div className="text-xs text-muted-foreground">{account.ownerId}</div>
                </td>
                <td className="py-2 pr-3">{account.ownerType === 'admin_user' ? '后台' : '前台'}</td>
                <td className={`py-2 pr-3 text-right ${negative ? 'text-destructive' : ''}`}>
                  {account.availableBalance.toFixed(2)}
                </td>
                <td className="py-2 pr-3 text-right">{account.cashBalance.toFixed(2)}</td>
                <td className="py-2 pr-3 text-right">{account.frozenAmount.toFixed(2)}</td>
                <td className="py-2 pr-3 text-right">{account.creditLimit.toFixed(2)}</td>
                <td className="py-2 pr-3">
                  {account.insufficientSince ? (
                    <Badge variant="destructive">欠费 {formatDateTime(account.insufficientSince)}</Badge>
                  ) : account.status === 'frozen' ? (
                    <Badge variant="secondary">已冻结</Badge>
                  ) : (
                    <Badge variant="outline">正常</Badge>
                  )}
                </td>
                <td className="py-2 pr-3 text-xs text-muted-foreground">
                  {formatDateTime(account.createdAt)}
                </td>
                <td className="py-2">
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
