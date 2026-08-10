import { useState } from 'react'
import type { BlackboardEntryData } from '@/graphql/workflow'
import { ChevronDown, ChevronRight, ClipboardList, Trash2 } from 'lucide-react'
import MarkdownContent from '@/components/session/MarkdownContent'

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
          <div className="text-xs text-muted-foreground">
            <MarkdownContent content={entry.value} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 可折叠分区：默认折叠，标题内联数量（对齐垃圾桶交互模式） */
function CollapsibleSection({
  title,
  count,
  icon,
  entries,
}: {
  title: string
  count: number
  icon: React.ReactNode
  entries: BlackboardEntryData[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-semibold text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        {icon}
        {title}（{count}）
      </button>
      {open && (
        <div className="mt-2">
          <EntryList entries={entries} />
        </div>
      )}
    </div>
  )
}

/** 工作流黑板与垃圾桶面板（均默认折叠，标题显示条目数量；内容以 Markdown 渲染） */
export default function BlackboardPanel({ blackboard, trash }: BlackboardPanelProps) {
  return (
    <div className="space-y-4">
      <CollapsibleSection
        title="工作流黑板"
        count={blackboard.length}
        icon={<ClipboardList className="size-3.5 text-muted-foreground" />}
        entries={blackboard}
      />
      <CollapsibleSection
        title="垃圾桶"
        count={trash.length}
        icon={<Trash2 className="size-3.5 text-muted-foreground" />}
        entries={trash}
      />
    </div>
  )
}
