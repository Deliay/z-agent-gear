import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { MODEL_RENAME_RECORDS } from '@/graphql/queries'
import type { ModelRenameRecordsQuery } from '@/graphql/types'
import CollapsibleGroup from '@/components/ui/collapsible-group'
import { QueryError } from '@/components/ui/query-error'
import { LoadingSkeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import * as T from '@/lib/table-styles'

/**
 * 「重名整理记录」只读区块：迁移 005 的历史改名对照台账。
 * 默认折叠，展开后才查询（避免首屏多余流量）。
 */
export default function ModelRenameRecordsPanel() {
  const [expanded, setExpanded] = useState(false)
  const { data, loading, error, refetch } = useQuery<ModelRenameRecordsQuery>(MODEL_RENAME_RECORDS, {
    skip: !expanded,
  })

  const records = data?.modelRenameRecords ?? []

  return (
    <CollapsibleGroup
      title="重名整理记录"
      count={expanded && data ? records.length : undefined}
      expanded={expanded}
      onToggle={() => setExpanded((prev) => !prev)}
    >
      {loading && !data ? (
        <LoadingSkeleton rows={2} className="border-0 p-0" />
      ) : error && !data ? (
        <QueryError message={error.message} onRetry={() => refetch()} />
      ) : records.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无重名整理记录
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className={T.TABLE_CLASS}>
            <thead>
              <tr className={T.TABLE_HEAD_CLASS}>
                <th className={T.TABLE_HEAD_CELL_CLASS}>原名 → 新名</th>
                <th className={T.TABLE_HEAD_CELL_CLASS}>供应商</th>
                <th className={T.TABLE_HEAD_CELL_CLASS}>整理时间</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id} className={T.TABLE_ROW_CLASS}>
                  <td className={T.TABLE_CELL_CLASS}>
                    <span className="text-foreground">{record.oldName}</span>
                    <span className="mx-1 text-muted-foreground">→</span>
                    <span className="font-medium text-foreground">{record.newName}</span>
                  </td>
                  <td className={T.TABLE_CELL_MUTED_CLASS}>{record.providerName}</td>
                  <td className={`${T.TABLE_CELL_MUTED_CLASS} tabular-nums`}>{formatDateTime(record.renamedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CollapsibleGroup>
  )
}
