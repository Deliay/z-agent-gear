import type { BillingInvoiceData, BillingReceiptData } from '@/graphql/types'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatDateTime } from '@/lib/format'
import { itemFormula, segmentLabel, unitLabel } from '@/lib/billing-format'

interface Props {
  invoice: BillingInvoiceData | null
  receipt: BillingReceiptData | null
  open: boolean
  loading?: boolean
  error?: string | null
  onClose: () => void
}

export default function ReceiptDrawer({ invoice, receipt, open, loading, error, onClose }: Props) {
  const description = error
    ? '收据加载失败，请稍后重试'
    : receipt
      ? `收据号 ${receipt.receiptNo}`
      : loading
        ? '收据加载中…'
        : '该账单暂无收据'
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>收据</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {invoice && (
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">账单序号</span>
              <span>{invoice.seq}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">时间</span>
              <span>{formatDateTime(invoice.createdAt)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">金额</span>
              <span>{invoice.amount.toFixed(2)} credits</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">支付后余额</span>
              <span>{invoice.balanceAfter.toFixed(2)} credits</span>
            </div>
            <div className="space-y-2 border-t pt-3">
              <div className="text-muted-foreground">用量与单价快照</div>
              {invoice.items.length === 0 ? (
                <p className="text-muted-foreground">无用量明细</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 font-medium">产品</th>
                      <th className="py-1 text-right font-medium">单价口径</th>
                      <th className="py-1 text-right font-medium">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.items.map((item, index) => (
                      <tr key={`${item.productId}-${index}`}>
                        <td className="py-1">
                          {item.productId}
                          {item.segment ? `（${segmentLabel(item.segment)}）` : ''}
                        </td>
                        <td className="py-1 text-right tabular-nums text-muted-foreground">
                          {unitLabel(item)}
                        </td>
                        <td className="py-1 text-right tabular-nums">
                          <div>{item.amount.toFixed(2)}</div>
                          <div className="text-muted-foreground">{itemFormula(item)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
