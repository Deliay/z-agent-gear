import type { BillingInvoiceData, BillingReceiptData } from '@/graphql/types'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { formatDateTime } from '@/lib/format'
import { itemFormula, segmentLabel, unitLabel } from '@/lib/billing-format'
import * as T from '@/lib/table-styles'

interface Props {
  invoice: BillingInvoiceData | null
  receipt: BillingReceiptData | null
  open: boolean
  loading?: boolean
  error?: string | null
  onClose: () => void
}

/**
 * 收据详情：右侧 Sheet（提案决策 D3），完整展示计费维度拆解。
 * 金额统一 `tabular-nums` 右对齐；入账成功色、异常警示色取语义 Token。
 */
export default function ReceiptDrawer({ invoice, receipt, open, loading, error, onClose }: Props) {
  const description = error
    ? '收据加载失败，请稍后重试'
    : receipt
      ? `收据号 ${receipt.receiptNo}`
      : loading
        ? '收据加载中…'
        : '该账单暂无收据'

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent data-testid="receipt-sheet">
        <SheetHeader>
          <SheetTitle>收据</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {invoice && (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">账单序号</dt>
              <dd className="text-right tabular-nums">{invoice.seq}</dd>
              <dt className="text-muted-foreground">时间</dt>
              <dd className="text-right">{formatDateTime(invoice.createdAt)}</dd>
              <dt className="text-muted-foreground">金额</dt>
              <dd
                className={`text-right tabular-nums ${
                  invoice.amount > 0 ? 'text-success' : 'text-foreground'
                }`}
              >
                {invoice.amount.toFixed(2)} credits
              </dd>
              <dt className="text-muted-foreground">支付后余额</dt>
              <dd className="text-right tabular-nums">{invoice.balanceAfter.toFixed(2)} credits</dd>
              {receipt && (
                <>
                  <dt className="text-muted-foreground">收据号</dt>
                  <dd className="truncate text-right font-mono text-xs">{receipt.receiptNo}</dd>
                  <dt className="text-muted-foreground">开具时间</dt>
                  <dd className="text-right">{formatDateTime(receipt.issuedAt)}</dd>
                </>
              )}
            </dl>

            <div className="space-y-2 border-t pt-3">
              <div className="text-muted-foreground">用量与单价快照</div>
              {invoice.items.length === 0 ? (
                <p className="text-muted-foreground">无用量明细</p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-0 text-xs">
                    <thead>
                      <tr className={T.TABLE_HEAD_CLASS}>
                        <th className={T.TABLE_HEAD_CELL_CLASS}>产品</th>
                        <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>单价口径</th>
                        <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoice.items.map((item, index) => (
                        <tr key={`${item.productId}-${index}`} className={T.TABLE_ROW_CLASS}>
                          <td className={T.TABLE_CELL_CLASS}>
                            {item.productId}
                            {item.segment ? `（${segmentLabel(item.segment)}）` : ''}
                          </td>
                          <td className={`${T.TABLE_CELL_NUMERIC_CLASS} text-muted-foreground`}>
                            {unitLabel(item)}
                          </td>
                          <td className={T.TABLE_CELL_NUMERIC_CLASS}>
                            <div>{item.amount.toFixed(2)}</div>
                            <div className="text-muted-foreground">{itemFormula(item)}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
