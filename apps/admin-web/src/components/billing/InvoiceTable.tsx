import type { BillingInvoiceData } from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/format'

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
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 pr-3 font-medium">序号</th>
            <th className="py-2 pr-3 font-medium">时间</th>
            <th className="py-2 pr-3 font-medium">类型</th>
            <th className="py-2 pr-3 font-medium">来源</th>
            <th className="py-2 pr-3 font-medium">描述</th>
            <th className="py-2 pr-3 text-right font-medium">金额</th>
            <th className="py-2 pr-3 text-right font-medium">入账后余额</th>
            <th className="py-2 font-medium">收据</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id} className="border-b last:border-0">
              <td className="py-2 pr-3 tabular-nums">{invoice.seq}</td>
              <td className="py-2 pr-3 text-xs text-muted-foreground">{formatDateTime(invoice.createdAt)}</td>
              <td className="py-2 pr-3">
                <Badge variant={invoice.type === 'recharge' ? 'secondary' : 'outline'}>
                  {invoice.type === 'recharge' ? '充值' : invoice.type === 'charge' ? '消费' : '调整'}
                </Badge>
              </td>
              <td className="py-2 pr-3">
                {invoice.category === 'container' ? '容器' : invoice.category === 'model' ? '模型' : '手工'}
              </td>
              <td className="max-w-[260px] truncate py-2 pr-3" title={invoice.description}>
                {invoice.description}
              </td>
              <td className={`py-2 pr-3 text-right tabular-nums ${invoice.amount < 0 ? 'text-destructive' : ''}`}>
                {invoice.amount.toFixed(2)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{invoice.balanceAfter.toFixed(2)}</td>
              <td className="py-2">
                {invoice.type === 'charge' ? (
                  <Button size="sm" variant="ghost" onClick={() => onViewReceipt(invoice)}>
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
  )
}
