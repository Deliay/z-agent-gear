import type { BillingInvoiceData } from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/format'
import { statusBadgeProps } from '@/lib/status-labels'
import * as T from '@/lib/table-styles'

interface Props {
  invoices: BillingInvoiceData[]
  onViewReceipt: (invoice: BillingInvoiceData) => void
}

export default function InvoiceTable({ invoices, onViewReceipt }: Props) {
  if (invoices.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无账单</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className={`${T.TABLE_CLASS} min-w-[760px]`}>
        <thead>
          <tr className={T.TABLE_HEAD_CLASS}>
            <th className={T.TABLE_HEAD_CELL_CLASS}>序号</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>时间</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>类型</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>来源</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>描述</th>
            <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>金额</th>
            <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>入账后余额</th>
            <th className={T.TABLE_HEAD_CELL_ACTION_CLASS}>收据</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => {
            const invoiceType = statusBadgeProps(invoice.type)
            return (
              <tr key={invoice.id} className={T.TABLE_ROW_CLASS}>
                <td className={`${T.TABLE_CELL_CLASS} tabular-nums`}>{invoice.seq}</td>
                <td className={`${T.TABLE_CELL_MUTED_CLASS} tabular-nums`}>{formatDateTime(invoice.createdAt)}</td>
                <td className={T.TABLE_CELL_CLASS}>
                  <Badge variant={invoiceType.variant}>{invoiceType.label}</Badge>
                </td>
                <td className={T.TABLE_CELL_CLASS}>
                  {invoice.category === 'container' ? '容器' : invoice.category === 'model' ? '模型' : invoice.category === 'storage' ? '存储' : '手工'}
                </td>
                <td className={`${T.TABLE_CELL_CLASS} max-w-[260px] truncate`} title={invoice.description}>
                  {invoice.description}
                </td>
                <td className={`${T.TABLE_CELL_NUMERIC_CLASS} ${invoice.amount > 0 ? 'text-success-text' : ''}`}>
                  {invoice.amount.toFixed(2)}
                </td>
                <td className={T.TABLE_CELL_NUMERIC_CLASS}>{invoice.balanceAfter.toFixed(2)}</td>
                <td className={T.TABLE_ACTION_CELL_CLASS}>
                  {/* R10-5：充值（recharge）账单同样有收据，不能再只对 charge 开放入口。 */}
                  {invoice.type === 'charge' || invoice.receiptId ? (
                    <Button size="sm" variant="ghost" onClick={() => onViewReceipt(invoice)}>
                      查看
                    </Button>
                  ) : (
                    '-'
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
