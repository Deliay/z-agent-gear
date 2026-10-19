import type { BillingInvoiceData, BillingReceiptData } from '@/graphql/types'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatDateTime } from '@/lib/format'

interface Props {
  invoice: BillingInvoiceData | null
  receipt: BillingReceiptData | null
  open: boolean
  onClose: () => void
}

export default function ReceiptDrawer({ invoice, receipt, open, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>收据</DialogTitle>
          <DialogDescription>
            {receipt ? `收据号 ${receipt.receiptNo}` : '该账单暂无收据'}
          </DialogDescription>
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
                      <th className="py-1 text-right font-medium">用量</th>
                      <th className="py-1 text-right font-medium">单价</th>
                      <th className="py-1 text-right font-medium">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.items.map((item, index) => (
                      <tr key={`${item.productId}-${index}`}>
                        <td className="py-1">
                          {item.productId}
                          {item.segment
                            ? `（${item.segment.includes('aborted') ? '中断' : item.segment}）`
                            : ''}
                        </td>
                        <td className="py-1 text-right tabular-nums">{item.quantity}</td>
                        <td className="py-1 text-right tabular-nums">{item.unitPrice.toFixed(4)}</td>
                        <td className="py-1 text-right tabular-nums">{item.amount.toFixed(2)}</td>
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
