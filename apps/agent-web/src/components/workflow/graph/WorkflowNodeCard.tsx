import { useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Loader2, RotateCcw, AlertCircle } from 'lucide-react'
import HumanNodeActions from '../HumanNodeActions'
import { NODE_STATUS_LABELS, NODE_STATUS_VISUAL } from '../WorkflowNodeTreeConstants'
import { useNodeSessionActivity, type NodeLiveActivity } from '@/hooks/useNodeSessionActivity'
import { ResourceChips } from './ResourceChip'
import type { WorkflowGraphNode } from './graph-layout'

export type WorkflowNodeCardNode = WorkflowGraphNode

/**
 * 工作流图表自定义节点卡片（PRD 功能点 9）：
 * 状态色左脊 + 名称 + 类型/返工徽标 + 元信息（Harness/模型）+ 进行中静态指示 +
 * 完成态 token 行 + PR/检查项徽标 + 资源小卡片 + 人类节点就地操作。
 *
 * 动态行按活动类型展示：思考「思考中...」、工具调用「执行中: {工具标题}」、
 * 文本输出「Concluding...」；不渲染正文（避免长文本撑高卡片）。
 * 人类交互与拖拽隔离：交互元素统一 `nodrag` + `stopPropagation`。
 */
function liveActivityLabel(activity: NodeLiveActivity | null): string {
  if (activity?.kind === 'tool_call') {
    return activity.text ? `执行中: ${activity.text}` : '执行中'
  }
  if (activity?.kind === 'text') return 'Concluding...'
  return '思考中...'
}

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
  const activityLabel = liveActivityLabel(activity)

  return (
    <div
      data-testid={`workflow-node-card-${data.nodeId}`}
      data-status={data.status}
      className={`relative flex flex-col gap-1 rounded-lg border border-border ${visual.tint} p-2 pl-3 text-card-foreground shadow-sm`}
      style={{ width: '100%' }}
    >
      {/* 依赖连线连接点：视觉隐藏但保留几何尺寸，不拦截卡片点击（缺 Handle 会导致边不渲染） */}
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
      />
      {/* 状态色左脊（4px） */}
      <span
        aria-hidden
        data-testid="node-status-spine"
        className={`absolute inset-y-0 left-0 w-1 rounded-l-lg ${visual.spine}`}
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

      {data.hasPendingInteraction && data.sessionId && data.onOpenSession && (
        <button
          type="button"
          data-testid={`node-pending-interaction-${data.nodeId}`}
          aria-label="有待处理的提问或审批"
          title="有待处理的提问或审批"
          className="nodrag flex w-fit items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-500 hover:bg-amber-500/20"
          onClick={(event) => {
            event.stopPropagation();
            data.onOpenSession?.(data.sessionId!);
          }}
        >
          <AlertCircle className="size-3" />
          待处理
        </button>
      )}

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
          <span className="min-w-0 truncate" title={activityLabel}>{activityLabel}</span>
        </div>
      )}

      {data.type === 'AI' && data.status === 'DONE' && (
        <div
          data-testid={`node-result-${data.nodeId}`}
          title="该数值为会话当前上下文长度"
          className="min-w-0 truncate text-[11px] text-success"
        >
          {tokenUsage != null ? `已完成 · ${tokenUsage} tokens` : '已完成'}
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

      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
      />
    </div>
  )
}
