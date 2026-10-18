import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { ADMIN_RECONCILIATION_REPORTS } from '@/graphql/queries'
import { RUN_RECONCILIATION } from '@/graphql/mutations'
import type { GetAdminReconciliationReportsQuery, ReconciliationReportData } from '@/graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/lib/format'

const LINES = [
  { value: 'funds', label: '资金对账' },
  { value: 'metering', label: '计量对账' },
  { value: 'resources', label: '资源对账' },
] as const

export default function ReconciliationPage() {
  const [reports, setReports] = useState<ReconciliationReportData[] | null>(null)
  const [running, setRunning] = useState(false)
  const { data } = useQuery<GetAdminReconciliationReportsQuery>(ADMIN_RECONCILIATION_REPORTS)
  const [runReconciliation] = useMutation(RUN_RECONCILIATION)

  const run = async (line?: string) => {
    setRunning(true)
    try {
      const result = await runReconciliation({ variables: { line: line ?? null } })
      const next = (result.data as { runReconciliation?: ReconciliationReportData[] } | undefined)
        ?.runReconciliation
      setReports(next ?? [])
      toast.success('对账完成')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '对账失败')
    } finally {
      setRunning(false)
    }
  }

  const shown = reports ?? data?.adminReconciliationReports ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-xl font-medium text-foreground">对账中心</h1>
        <Button onClick={() => run()} disabled={running}>
          运行全部对账
        </Button>
      </div>

      <div className="flex gap-2">
        {LINES.map((line) => (
          <Button key={line.value} variant="outline" size="sm" onClick={() => run(line.value)} disabled={running}>
            {line.label}
          </Button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">尚无对账结果，点击上方按钮运行。</p>
      ) : (
        shown.map((report) => (
          <Card key={`${report.line}-${report.ranAt}`}>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>
                {report.line === 'funds' ? '资金对账' : report.line === 'metering' ? '计量对账' : '资源对账'}
              </CardTitle>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{formatDateTime(report.ranAt)}</span>
                <Badge variant={report.errorCount > 0 ? 'destructive' : 'outline'}>
                  {report.errorCount > 0 ? `${report.errorCount} 项差错` : '通过'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="text-muted-foreground">检查 {report.checkedCount} 项</div>
              {report.errors.length > 0 && (
                <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify(report.errors, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}
