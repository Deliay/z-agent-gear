import { useState } from 'react'
import type { BlackboardEntryData } from '@/graphql/workflow'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'

interface BlackboardPanelProps {
  blackboard: BlackboardEntryData[]
  trash: BlackboardEntryData[]
}

function EntryList({ entries }: { entries: BlackboardEntryData[] }) {
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">暂无内容</p>
  }
  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div key={entry.key} className="rounded-md border bg-muted/30 p-2">
          <div className="mb-1 break-all text-xs font-medium text-foreground">{entry.key}</div>
          <pre className="text-xs break-all whitespace-pre-wrap text-muted-foreground">
            {entry.value}
          </pre>
        </div>
      ))}
    </div>
  )
}

/** 工作流黑板与垃圾桶面板 */
export default function BlackboardPanel({ blackboard, trash }: BlackboardPanelProps) {
  const [trashOpen, setTrashOpen] = useState(false)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">工作流黑板</h3>
        <EntryList entries={blackboard} />
      </div>

      <div>
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-semibold text-foreground"
          onClick={() => setTrashOpen((prev) => !prev)}
          aria-expanded={trashOpen}
        >
          {trashOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          <Trash2 className="size-3.5 text-muted-foreground" />
          垃圾桶（{trash.length}）
        </button>
        {trashOpen && (
          <div className="mt-2">
            <EntryList entries={trash} />
          </div>
        )}
      </div>
    </div>
  )
}
