import { ClipboardList, GitPullRequest, MessageSquareText, Plus } from 'lucide-react'
import type { GraphResource } from './graph-layout'

const KIND_ICON = {
  blackboard: ClipboardList,
  pr: GitPullRequest,
  prompt: MessageSquareText,
} as const

const KIND_LABEL = {
  blackboard: '黑板',
  pr: 'PR',
  prompt: '追加提示词',
} as const

interface ResourceChipProps {
  resource: GraphResource
  onOpen?: (resource: GraphResource) => void
}

/** 资源小卡片：类型图标 + 标题单行截断，限宽 12rem（不参与 dagre 测量） */
export default function ResourceChip({ resource, onOpen }: ResourceChipProps) {
  const Icon = KIND_ICON[resource.kind]
  return (
    <button
      type="button"
      data-testid={`resource-chip-${resource.kind}`}
      title={`${KIND_LABEL[resource.kind]}：${resource.title}`}
      className="nodrag flex max-w-48 min-w-0 items-center gap-1 rounded border bg-background/80 px-1.5 py-0.5 text-left text-[10px] text-foreground transition-colors hover:bg-muted"
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.(resource)
      }}
    >
      <Icon className="size-3 shrink-0 text-muted-foreground" />
      <span className="line-clamp-2 min-w-0 break-all text-left leading-tight">{resource.title}</span>
      {resource.checkRunUrl && (
        <span className="shrink-0 rounded bg-success/15 px-1 text-[9px] text-success">检查项</span>
      )}
    </button>
  )
}

interface ResourceChipsProps {
  resources: GraphResource[]
  moreResources?: number
  onOpen?: (resource: GraphResource) => void
  /** 实例资源行使用横排换行；节点内资源行不换行（单行横向排布） */
  wrap?: boolean
  /** 「+N」折叠入口：打开节点详情抽屉的资源列表区 */
  onOpenMore?: () => void
}

/** 资源行：最多 3 个可见小卡片 + 「+N」折叠入口 */
export function ResourceChips({
  resources,
  moreResources = 0,
  onOpen,
  wrap,
  onOpenMore,
}: ResourceChipsProps) {
  if (resources.length === 0 && moreResources === 0) return null
  return (
    <div
      data-testid="resource-row"
      className={`flex min-w-0 gap-1 ${wrap ? 'flex-wrap' : 'flex-nowrap overflow-hidden'}`}
    >
      {resources.map((resource) => (
        <ResourceChip key={resource.id} resource={resource} onOpen={onOpen} />
      ))}
      {moreResources > 0 && (
        <button
          type="button"
          className="nodrag inline-flex shrink-0 items-center gap-0.5 rounded border bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
          onClick={(event) => {
            event.stopPropagation()
            onOpenMore?.()
          }}
        >
          <Plus className="size-2.5" />
          {moreResources}
        </button>
      )}
    </div>
  )
}
