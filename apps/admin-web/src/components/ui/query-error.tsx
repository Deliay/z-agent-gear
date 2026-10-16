import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface QueryErrorProps {
  message: string
  onRetry?: () => void
}

/**
 * 列表查询失败态。区别于空态：接口/网络故障时必须显式暴露，避免管理员
 * 把「加载失败」误判成「暂无数据」并据此误操作。
 */
export function QueryError({ message, onRetry }: QueryErrorProps) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center"
    >
      <AlertTriangle className="mx-auto size-8 text-destructive" aria-hidden="true" />
      <p className="mt-2 text-sm font-medium text-destructive">数据加载失败</p>
      <p className="mt-1 break-all text-xs text-muted-foreground">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  )
}
