import { ExternalLink, MessageSquare, RotateCcw } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import MarkdownContent from '@/components/session/MarkdownContent'
import { artifactsOf } from '@/lib/artifact-owners'
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow'
import { NODE_STATUS_BADGE, NODE_STATUS_LABELS, NODE_TYPE_LABELS } from './WorkflowNodeTreeConstants'
import HumanNodeActions from './HumanNodeActions'
import type { GraphResource } from './graph/graph-layout'

export type NodeDetailTarget =
  | { type: 'node'; nodeId: string }
  | { type: 'resource'; resource: GraphResource }

interface NodeDetailDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instance: WorkflowInstanceData
  target: NodeDetailTarget | null
  onOpenSession?: (sessionId: string) => void
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] items-start gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 wrap-anywhere text-foreground">{value}</span>
    </div>
  )
}

function NodeDetail({ instance, node, onOpenSession }: {
  instance: WorkflowInstanceData
  node: WorkflowNodeData
  onOpenSession?: (sessionId: string) => void
}) {
  const nodeArtifacts = artifactsOf(node, instance.blackboard)
  const nodeLinks = instance.pullRequestLinks.filter((link) => link.nodeId === node.id)
  const actionable =
    node.type === 'HUMAN' &&
    (node.status === 'READY' || node.status === 'RUNNING' || node.status === 'REWORK')

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {NODE_TYPE_LABELS[node.type]}
        </span>
        <span
          data-testid="drawer-node-status"
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${NODE_STATUS_BADGE[node.status]}`}
        >
          {NODE_STATUS_LABELS[node.status]}
        </span>
        {node.reworkCount > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
            <RotateCcw className="size-3" />
            返工 {node.reworkCount} 次
          </span>
        )}
        {node.sessionId && onOpenSession && (
          <Button size="xs" variant="outline" onClick={() => onOpenSession(node.sessionId!)}>
            <MessageSquare className="size-3" />
            打开会话
          </Button>
        )}
      </div>

      <div className="space-y-1.5">
        <Field label="阶段" value={node.stage} />
        <Field label="说明" value={node.description || '—'} />
        {node.startedAt && <Field label="开始时间" value={node.startedAt} />}
        {node.reworkedAt && <Field label="最近返工" value={node.reworkedAt} />}
      </div>

      {node.rejectInfo && node.status === 'REJECT' && (
        <div className="rounded bg-destructive/10 px-2 py-1 text-xs wrap-anywhere text-destructive">
          打回理由：{node.rejectInfo.reason}
        </div>
      )}
      {node.failInfo && node.status === 'FAILED' && (
        <div className="rounded bg-destructive/10 px-2 py-1 text-xs wrap-anywhere text-destructive">
          失败原因：{node.failInfo.reason}
        </div>
      )}

      {nodeArtifacts.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">产物（{nodeArtifacts.length}）</div>
          {nodeArtifacts.map((artifact) => (
            <div key={artifact.title} className="min-w-0 rounded-md border bg-muted/30 p-2">
              <div className="mb-0.5 text-xs wrap-anywhere font-medium text-foreground">{artifact.title}</div>
              <div className="min-w-0 text-xs text-muted-foreground">
                <MarkdownContent content={artifact.value} />
              </div>
            </div>
          ))}
        </div>
      )}

      {nodeLinks.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">关联 Pull Request</div>
          {nodeLinks.map((link) => (
            <div key={`${link.nodeId}-${link.pullRequestId}`} className="min-w-0 rounded-md border bg-muted/30 p-2">
              <div className="text-xs font-medium text-foreground">{link.pullRequestId}</div>
              {link.prUrl && (
                <a
                  href={link.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 flex min-w-0 items-center gap-1 break-all text-xs text-primary hover:underline"
                >
                  <ExternalLink className="size-3 shrink-0" />
                  {link.prUrl}
                </a>
              )}
              {link.checkRunUrl && (
                <div className="mt-0.5 min-w-0 break-all text-xs text-muted-foreground">
                  检查项：
                  <a
                    href={link.checkRunUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={
                      link.lastSyncedCommitSha
                        ? `检查项 · commit ${link.lastSyncedCommitSha.slice(0, 7)}`
                        : '检查项'
                    }
                    className="text-primary hover:underline"
                  >
                    检查项
                  </a>
                  {link.lastSyncedCommitSha && (
                    <> · commit {link.lastSyncedCommitSha.slice(0, 7)}</>
                  )}
                </div>
              )}
              {link.lastSyncAt && (
                <div className="mt-0.5 text-xs text-muted-foreground">最近同步：{link.lastSyncAt}</div>
              )}
              {link.lastSyncError && (
                <div className="mt-0.5 break-all text-xs text-destructive">{link.lastSyncError}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {actionable && <HumanNodeActions instanceId={instance.id} node={node} />}
    </div>
  )
}

function ResourceDetail({ resource }: { resource: GraphResource }) {
  if (resource.kind === 'pr') {
    return (
      <div className="min-w-0 space-y-2">
        <div className="text-xs font-medium text-foreground">{resource.title}</div>
        {resource.url && (
          <a
            href={resource.url}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-1 break-all text-xs text-primary hover:underline"
          >
            <ExternalLink className="size-3 shrink-0" />
            {resource.url}
          </a>
        )}
        {resource.checkRunUrl && (
          <div className="min-w-0 break-all text-xs text-muted-foreground">
            检查项：
            <a
              href={resource.checkRunUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {resource.checkRunUrl}
            </a>
          </div>
        )}
      </div>
    )
  }

  if (resource.kind === 'prompt') {
    return (
      <div className="min-w-0 space-y-2">
        <div className="break-all text-xs font-medium text-foreground">{resource.title}</div>
        {/* 追加提示词可能来自外部审核意见：按普通文本渲染，不解析 Markdown */}
        <p className="min-w-0 whitespace-pre-wrap break-all text-xs text-muted-foreground">
          {resource.value}
        </p>
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="break-all text-xs font-medium text-foreground">{resource.title}</div>
      <div className="min-w-0 text-xs text-muted-foreground">
        <MarkdownContent content={resource.value ?? ''} />
      </div>
    </div>
  )
}

/** 节点 / 资源详情抽屉（图表模式与列表视图共用；关闭后视图位置不变） */
export default function NodeDetailDrawer({
  open,
  onOpenChange,
  instance,
  target,
  onOpenSession,
}: NodeDetailDrawerProps) {
  const node = target?.type === 'node' ? instance.nodes.find((item) => item.id === target.nodeId) ?? null : null

  const title =
    target?.type === 'node'
      ? node?.name ?? '节点详情'
      : target?.type === 'resource'
        ? target.resource.title
        : '详情'
  const description =
    target?.type === 'node'
      ? node
        ? `${node.stage} · ${NODE_STATUS_LABELS[node.status]}`
        : '节点不存在'
      : target?.type === 'resource'
        ? target.resource.kind === 'pr'
          ? '关联 Pull Request'
          : target.resource.kind === 'prompt'
            ? '追加提示词'
            : '黑板产物'
        : undefined

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="node-detail-drawer">
        <SheetHeader>
          <SheetTitle className="break-all">{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 min-w-0 flex-1">
          {target?.type === 'node' && node && (
            <NodeDetail instance={instance} node={node} onOpenSession={onOpenSession} />
          )}
          {target?.type === 'node' && !node && (
            <p className="text-xs text-muted-foreground">节点不存在或已被删除</p>
          )}
          {target?.type === 'resource' && <ResourceDetail resource={target.resource} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
