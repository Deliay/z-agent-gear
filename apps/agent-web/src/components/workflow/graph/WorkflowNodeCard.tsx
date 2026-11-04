import { useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Loader2, RotateCcw } from 'lucide-react'
import HumanNodeActions from '../HumanNodeActions'
import { NODE_STATUS_LABELS, NODE_STATUS_VISUAL } from '../WorkflowNodeTreeConstants'
import { useNodeSessionActivity } from '@/hooks/useNodeSessionActivity'
import { ResourceChips } from './ResourceChip'
import type { WorkflowGraphNode } from './graph-layout'

export type WorkflowNodeCardNode = WorkflowGraphNode

function activityText(kind: 'thinking' | 'tool_call' | 'text', text: string): string {
  if (kind === 'thinking') return text ? `思考中 ${text}` : '思考中'
  if (kind === 'text') return text ? `总结中 ${text}` : '总结中'
  return text
}

/**
 * 工作流图表自定义节点卡片（PRD 功能点 9）：
 * 状态色左脊 + 名称 + 类型/返工徽标 + 元信息（Harness/模型）+ 进行中动态行 +
 * 完成态 token 行 + PR/检查项徽标 + 资源小卡片 + 人类节点就地操作。
 *
 * 动态行走局部 hook 状态，不触发 `setNodes`，避免整图抖动；
 * 交互元素统一 `nodrag` + `stopPropagation`，拖拽仅由卡片非交互区触发。
 */
export default function WorkflowNodeCard({ data }: NodeProps<WorkflowNodeCardNode>) {
  const visual = NODE_STATUS_VISUAL[data.status]
  const isAiRunning =
    data.type === 'AI' && (data.status === 'RUNNING' || data.status === 'REWORK')
  // 首屏即为 DONE 的 AI 节点：短连一次拉 history 补 token；运行中完成的节点沿用已捕获用量
  const [doneOnMount] = useState(() => data.type === 'AI' && data.status === 'DONE')
  const { activity, tokenUsage } = useNodeSessionActivity({
    sessionId: data.sessionId,
    active: isAiRunning,
    snapshot: doneOnMount && data.status === 'DONE',
  })

  return (
    <div
      data-testid={`workflow-node-card-${data.nodeId}`}
      data-status={data.status}
      className={`relative flex flex-col gap-1 rounded-lg border border-border ${visual.tint} p-2 pl-3 text-card-foreground shadow-sm`}
      style={{ width: '100%' }}
    >
      {/* 状态色左脊（4px） */}
      <span
        aria-hidden
        data-testid="node-status-spine"
        className={`absolute inset-y-0 left-0 w-1 rounded-l-lg ${visual.spine}`}
      />

      {/* React Flow 连线锚点：竖向布局，入边在顶、出边在底（不可交互、视觉隐藏） */}
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!size-1 !border-0 !bg-transparent"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!size-1 !border-0 !bg-transparent"
      />

      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5 text-left"
        onClick={() => data.onOpenDetail(data.nodeId)}
        aria-label={`${data.name} 详情`}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {data.name}
        </span>
        {data.reworkCount > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-warning/15 px-1 text-[10px] text-warning">
            <RotateCcw className="size-2.5" />
            {data.reworkCount}
          </span>
        )}
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {data.type === 'AI' ? 'AI' : data.type === 'HUMAN' ? '人类' : '旗帜'}
        </span>
        <span
          data-testid={`node-status-badge-${data.nodeId}`}
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${visual.badge}`}
        >
          {NODE_STATUS_LABELS[data.status]}
        </span>
      </button>

      {data.type === 'AI' && (data.harness || data.model) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {data.harness && (
            <span className="rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
              {data.harness}
            </span>
          )}
          {data.model && (
            <span
              className="max-w-40 truncate rounded bg-secondary px-1 py-0.5 text-[10px] text-secondary-foreground"
              title={data.model}
            >
              {data.model}
            </span>
          )}
        </div>
      )}

      {isAiRunning && (
        <div
          data-testid={`node-live-activity-${data.nodeId}`}
          className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
        >
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">
            {activity ? activityText(activity.kind, activity.text) : '等待消息'}
          </span>
        </div>
      )}

      {data.type === 'AI' && data.status === 'DONE' && (
        <div data-testid={`node-result-${data.nodeId}`} className="min-w-0 truncate text-[11px] text-success">
          {tokenUsage != null ? `已完成 · 消耗 ${tokenUsage} tokens` : '已完成'}
        </div>
      )}

      {(data.prLinks.length > 0 || data.hasCheckRun) && (
        <div className="nodrag flex min-w-0 flex-wrap items-center gap-1">
          {data.prLinks.map((link) =>
            link.prUrl ? (
              <a
                key={`pr-${link.pullRequestId}`}
                href={link.prUrl}
                target="_blank"
                rel="noreferrer"
                title={link.pullRequestId}
                className="rounded bg-primary/15 px-1 py-0.5 text-[10px] text-primary hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                PR
              </a>
            ) : (
              <span
                key={`pr-${link.pullRequestId}`}
                title={link.pullRequestId}
                className="rounded bg-primary/15 px-1 py-0.5 text-[10px] text-primary"
              >
                PR
              </span>
            ),
          )}
          {data.prLinks
            .filter((link) => link.checkRunUrl)
            .map((link) => (
              <a
                key={`check-${link.pullRequestId}`}
                href={link.checkRunUrl!}
                target="_blank"
                rel="noreferrer"
                title={link.lastSyncedCommitSha ? `检查项 · commit ${link.lastSyncedCommitSha.slice(0, 7)}` : '检查项'}
                className="rounded bg-success/15 px-1 py-0.5 text-[10px] text-success hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                检查项
              </a>
            ))}
        </div>
      )}

      <ResourceChips
        resources={data.resources}
        moreResources={data.moreResources}
        onOpen={data.onOpenResource}
        onOpenMore={() => data.onOpenDetail(data.nodeId)}
      />

      {data.actionable && (
        <HumanNodeActions instanceId={data.instanceId} node={{ id: data.nodeId, name: data.name }} compact />
      )}
    </div>
  )
}
