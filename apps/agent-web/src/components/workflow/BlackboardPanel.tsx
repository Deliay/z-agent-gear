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
    <div className="divide-y divide-border rounded-md border border-border bg-muted/30">
      {entries.map((entry) => (
        <div key={entry.key} className="p-2.5">
          <div className="mb-1 break-all text-xs font-medium text-foreground">{entry.key}</div>
          <div className="min-w-0 text-xs text-muted-foreground">
            <MarkdownContent content={entry.value} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 可折叠分区卡片：默认折叠，标题内联等宽数量徽标 */
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
    <section className="rounded-lg border border-border bg-card p-3">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label={`${title}（${count}）`}
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        {icon}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      </button>
      {open && (
        <div className="mt-2.5 border-t border-border pt-2.5">
          <EntryList entries={entries} />
        </div>
      )}
    </section>
  )
}

/** 工作流黑板与垃圾桶面板（结构化卡片容器，均默认折叠；内容以 Markdown 渲染） */
export default function BlackboardPanel({ blackboard, trash }: BlackboardPanelProps) {
  return (
    <div className="min-w-0 space-y-3">
      <CollapsibleSection
        title="工作流黑板"
        count={blackboard.length}
        icon={<ClipboardList className="size-3.5 shrink-0 text-muted-foreground" />}
        entries={blackboard}
      />
      <CollapsibleSection
        title="垃圾桶"
        count={trash.length}
        icon={<Trash2 className="size-3.5 shrink-0 text-muted-foreground" />}
        entries={trash}
      />
    </div>
  )
}
