import type { BillingRollupData } from '@/graphql/types'
import { formatDateTime } from '@/lib/format'

interface Props {
  rollups: BillingRollupData[]
}

/** 汇总趋势（无图表库依赖）：按消费金额占比渲染横向条形。 */
export default function RollupChart({ rollups }: Props) {
  if (rollups.length === 0) {
    return <p className="text-sm text-muted-foreground">该时段暂无汇总数据</p>
  }
  const max = Math.max(...rollups.map((item) => Math.max(item.chargeTotal, item.rechargeTotal)), 1)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-chart-5" aria-hidden="true" />
          消费
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-chart-2" aria-hidden="true" />
          充值
        </span>
      </div>
      <div className="space-y-2">
        {rollups.map((item) => (
          <div key={item.bucketStart} className="space-y-1">
            <div className="flex justify-between gap-2 text-xs tabular-nums text-muted-foreground">
              <span>{formatDateTime(item.bucketStart)}</span>
              <span>
                消费 {item.chargeTotal.toFixed(2)} · 充值 {item.rechargeTotal.toFixed(2)} · {item.chargeCount} 笔
              </span>
            </div>
            <div className="flex gap-1">
              <div className="h-2 flex-1 rounded bg-muted">
                <div
                  className="h-2 rounded bg-chart-5"
                  style={{ width: `${(item.chargeTotal / max) * 100}%` }}
                />
              </div>
              <div className="h-2 flex-1 rounded bg-muted">
                <div
                  className="h-2 rounded bg-chart-2"
                  style={{ width: `${(item.rechargeTotal / max) * 100}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
