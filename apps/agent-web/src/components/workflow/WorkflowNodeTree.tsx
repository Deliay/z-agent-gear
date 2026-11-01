import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import MarkdownContent from '@/components/session/MarkdownContent'
import { GET_ACP_CAPABILITIES } from '@/graphql/queries'
import type { GetAcpCapabilitiesQuery } from '@/graphql/types'
import {
  type WorkflowInstanceData,
  type WorkflowNodeData,
  type BlackboardEntryData,
  type WorkflowNodeStatus,
  type WorkflowPullRequestLinkData,
} from '@/graphql/workflow'
import EditInstanceNodeDialog from './EditInstanceNodeDialog'
import HumanNodeActions from './HumanNodeActions'
import { artifactsOf } from '@/lib/artifact-owners'
import { NODE_TYPE_LABELS, NODE_STATUS_LABELS, NODE_STATUS_BADGE } from './WorkflowNodeTreeConstants'
import { ChevronDown, ChevronRight, MessageSquare, RotateCcw, Pencil, RefreshCw, PanelRight } from 'lucide-react'

interface WorkflowNodeTreeProps {
  instance: WorkflowInstanceData
  onOpenSession: (sessionId: string) => void
  /** 实例关联的 Pull Request（按 nodeId 展示徽标） */
  pullRequestLinks?: WorkflowPullRequestLinkData[]
  /** 打开节点详情抽屉（PRD 功能点 6：列表视图同样可打开） */
  onOpenDetail?: (nodeId: string) => void
}

/** 默认折叠的状态：已完成/等待中（其余状态默认展开，需关注或可操作） */
const DEFAULT_COLLAPSED_STATUSES: WorkflowNodeStatus[] = ['DONE', 'INITIALIZING']

/** 单个节点卡片：支持折叠（折叠后只展示节点类型与标题）；头部行 flex-wrap 适配窄屏 */
function NodeCard({
  instanceId,
  node,
  blackboard,
  onOpenSession,
  onEdit,
  pullRequestLinks = [],
  onOpenDetail,
}: {
  instanceId: string
  node: WorkflowNodeData
  blackboard: BlackboardEntryData[]
  onOpenSession: (sessionId: string) => void
  onEdit: (node: WorkflowNodeData, restartMode?: boolean) => void
  pullRequestLinks?: WorkflowPullRequestLinkData[]
  onOpenDetail?: (nodeId: string) => void
}) {
  // 用户手动切换后以其为准，否则按状态取默认值（状态流转后默认值自动跟随）
  const [toggled, setToggled] = useState<boolean | null>(null)
  const collapsed = toggled ?? DEFAULT_COLLAPSED_STATUSES.includes(node.status)
  const nodeArtifacts = artifactsOf(node, blackboard)
  const nodeLinks = pullRequestLinks.filter((link) => link.nodeId === node.id)

  // 头部行折叠/展开均展示（类型、标题、状态 badge、返工次数、会话按钮）；折叠仅隐藏内容区
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="flex items-center"
          onClick={() => setToggled(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `${node.name} 展开` : `${node.name} 折叠`}
        >
          {collapsed ? (
            <ChevronRight className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>
        <Badge variant="secondary">{NODE_TYPE_LABELS[node.type]}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.name}</span>
        {node.type === 'AI' && node.agentConfig && (
          <div className="flex items-center gap-1">
            <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {node.agentConfig.acpServerType}
            </span>
            {node.agentConfig.modelId && (
              <span className="rounded bg-secondary/20 px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                {node.agentConfig.modelId}
              </span>
            )}
          </div>
        )}
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${NODE_STATUS_BADGE[node.status]}`}
        >
          {NODE_STATUS_LABELS[node.status]}
        </span>
        {nodeLinks.map((link) =>
          link.prUrl ? (
            <a
              key={link.pullRequestId}
              href={link.prUrl}
              target="_blank"
              rel="noreferrer"
              title={link.pullRequestId}
              className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:underline"
            >
              PR
            </a>
          ) : (
            // C-20：无链接时渲染 span，避免无障碍树中出现无 href 的死链接
            <span
              key={link.pullRequestId}
              title={link.pullRequestId}
              className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            >
              PR
            </span>
          ),
        )}
        {/* check-run 同步信息：未同步时不渲染（保持现状观感） */}
        {nodeLinks.map((link) =>
          link.checkRunUrl ? (
            <a
              key={`check-run-${link.pullRequestId}`}
              href={link.checkRunUrl}
              target="_blank"
              rel="noreferrer"
              title={
                link.lastSyncedCommitSha
                  ? `检查项 · commit ${link.lastSyncedCommitSha.slice(0, 7)}`
                  : '检查项'
              }
              className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 hover:underline dark:text-emerald-400"
            >
              检查项
            </a>
          ) : null,
        )}
        {node.reworkCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <RotateCcw className="size-3" />
            返工 {node.reworkCount} 次
          </span>
        )}
        {(node.status === 'INITIALIZING' || node.status === 'READY') && (
          <Button size="xs" variant="outline" onClick={() => onEdit(node)}>
            <Pencil className="size-3" />
            编辑
          </Button>
        )}
        {node.type === 'AI' &&
          (node.status === 'RUNNING' || node.status === 'REWORK' || node.status === 'FAILED') && (
            <Button size="xs" variant="outline" onClick={() => onEdit(node, true)}>
              <RefreshCw className="size-3" />
              重启
            </Button>
          )}
        {onOpenDetail && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onOpenDetail(node.id)}
            aria-label={`${node.name} 详情`}
          >
            <PanelRight className="size-3" />
            详情
          </Button>
        )}
        {node.sessionId && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onOpenSession(node.sessionId!)}
          >
            <MessageSquare className="size-3" />
            会话
          </Button>
        )}
      </div>
      {!collapsed && (
      <>
      {node.description && (
        <p className="mt-1 text-xs wrap-anywhere text-muted-foreground">{node.description}</p>
      )}
      {node.type === 'AI' && node.prompts && node.prompts.length > 0 && (
        <div className="mt-2 space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            节点提示词（实例节点为实例化时的副本）
          </div>
          {node.prompts.map((prompt, i) => (
            <p key={i} className="text-xs text-muted-foreground">{prompt}</p>
          ))}
        </div>
      )}
      {node.rejectInfo && node.status === 'REJECT' && (
        <p className="mt-1 rounded bg-destructive/10 px-2 py-1 text-xs wrap-anywhere text-destructive">
          打回理由：{node.rejectInfo.reason}
        </p>
      )}
      {node.failInfo && node.status === 'FAILED' && (
        <div className="mt-1 rounded bg-destructive/10 px-2 py-1 text-xs wrap-anywhere text-destructive">
          <p>失败原因：{node.failInfo.reason}</p>
          <p className="mt-0.5 text-destructive/80">
            需要人工介入：打开节点会话说明处理方式，AI 确认后会将节点恢复为运行状态。
          </p>
        </div>
      )}
      {nodeArtifacts.length > 0 && (
        <div className="mt-2 space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">
            产物（{nodeArtifacts.length}）
          </div>
          {nodeArtifacts.map((artifact) => (
            <div key={artifact.title} className="rounded-md border bg-muted/30 p-2">
              <div className="mb-0.5 text-xs wrap-anywhere font-medium text-foreground">
                {artifact.title}
              </div>
              <div className="text-xs text-muted-foreground">
                <MarkdownContent content={artifact.value} />
              </div>
            </div>
          ))}
        </div>
      )}
      {node.type === 'HUMAN' &&
        (node.status === 'READY' || node.status === 'RUNNING' || node.status === 'REWORK') && (
          <HumanNodeActions instanceId={instanceId} node={node} />
        )}
      </>
      )}
    </div>
  )
}

export default function WorkflowNodeTree({
  instance,
  onOpenSession,
  pullRequestLinks = [],
  onOpenDetail,
}: WorkflowNodeTreeProps) {
  const stages: string[] = []
  for (const node of instance.nodes) {
    if (!stages.includes(node.stage)) stages.push(node.stage)
  }

  const [editNode, setEditNode] = useState<WorkflowNodeData | null>(null)
  const [editNodeRestartMode, setEditNodeRestartMode] = useState(false)
  const { data: capabilitiesData } = useQuery<GetAcpCapabilitiesQuery>(GET_ACP_CAPABILITIES, {
    variables: { controllerId: instance.controllerId },
    skip: !instance.controllerId,
  })
  const availableServerTypes = (capabilitiesData?.acpCapabilities ?? [])
    .filter((c) => c.available && c.type)
    .map((c) => c.type)

  // 编辑按钮点击
  const handleEdit = (node: WorkflowNodeData, restartMode = false) => {
    setEditNode(node)
    setEditNodeRestartMode(restartMode)
  }

  return (
    <div className="min-w-0 space-y-6">
      {stages.map((stage) => (
        <div key={stage}>
          <h3 className="mb-2 text-sm font-semibold text-foreground">{stage}</h3>
          <div className="space-y-2">
            {instance.nodes
              .filter((node) => node.stage === stage)
              .map((node) => (
                <NodeCard
                  key={node.id}
                  instanceId={instance.id}
                  node={node}
                  blackboard={instance.blackboard}
                  onOpenSession={onOpenSession}
                  onEdit={handleEdit}
                  pullRequestLinks={pullRequestLinks}
                  onOpenDetail={onOpenDetail}
                />
              ))}
          </div>
        </div>
      ))}
      {editNode && (
        <EditInstanceNodeDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditNode(null)
              setEditNodeRestartMode(false)
            }
          }}
          instanceId={instance.id}
          node={editNode}
          controllerId={instance.controllerId}
          availableServerTypes={availableServerTypes}
          restartMode={editNodeRestartMode}
        />
      )}
    </div>
  )
}
