import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  GET_WORKFLOW_INSTANCE,
  DELETE_WORKFLOW_INSTANCE,
  ARCHIVE_WORKFLOW_INSTANCE,
  type GetWorkflowInstanceQuery,
  type WorkflowNodeData,
} from '@/graphql/workflow'
import { GET_ACP_CAPABILITIES } from '@/graphql/queries'
import type { GetAcpCapabilitiesQuery } from '@/graphql/types'
import WorkflowNodeTree from '@/components/workflow/WorkflowNodeTree'
import WorkflowGraphView from '@/components/workflow/WorkflowGraphView'
import EditInstanceNodeDialog from '@/components/workflow/EditInstanceNodeDialog'
import { NODE_STATUS_BADGE, NODE_STATUS_LABELS } from '@/components/workflow/WorkflowNodeTreeConstants'
import BlackboardPanel from '@/components/workflow/BlackboardPanel'
import WorkflowContextPanel from '@/components/workflow/WorkflowContextPanel'
import SessionSidePanel from '@/components/workflow/SessionSidePanel'
import NodeDetailDrawer, { type NodeDetailTarget } from '@/components/workflow/NodeDetailDrawer'
import MobileBackButton from '@/components/MobileBackButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Archive, ArchiveRestore, Trash2, List, GitBranch } from 'lucide-react'

export default function WorkflowInstancePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [sideSessionId, setSideSessionId] = useState<string | null>(null)
  // 节点/资源详情抽屉：图表与列表共用，状态提升到页面层（轮询刷新不重置）
  const [detailTarget, setDetailTarget] = useState<NodeDetailTarget | null>(null)
  // 抽屉内「重启节点」：复用实例节点对话框 restartMode（页面级持有，列表视图另有自己的对话框）
  const [restartTarget, setRestartTarget] = useState<WorkflowNodeData | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteWorkflowInstance] = useMutation(DELETE_WORKFLOW_INSTANCE)
  const [archiveWorkflowInstance] = useMutation(ARCHIVE_WORKFLOW_INSTANCE)
  // 视图切换：List/Graph，localStorage 持久化
  const [viewMode, setViewMode] = useState<'list' | 'graph'>(() => {
    const saved = localStorage.getItem('workflow-view-mode')
    return (saved === 'graph' || saved === 'list') ? saved : 'list'
  })

  const handleViewModeChange = (mode: 'list' | 'graph') => {
    setViewMode(mode)
    localStorage.setItem('workflow-view-mode', mode)
  }

  const { data, loading } = useQuery<GetWorkflowInstanceQuery>(GET_WORKFLOW_INSTANCE, {
    variables: { id: id ?? '' },
    skip: !id,
    pollInterval: 5000,
    // Apollo v4 默认 notifyOnNetworkStatusChange=true：轮询会反复置 loading，
    // 导致整页卸载成 spinner、打断用户输入；轮询期间保持渲染现有内容。
    notifyOnNetworkStatusChange: false,
  })

  const instance = data?.workflowInstance
  const nodes = instance?.nodes

  // 重启对话框的可用 Harness 列表（与列表视图同源；控制器能力查询可复用缓存）
  const { data: capabilitiesData } = useQuery<GetAcpCapabilitiesQuery>(GET_ACP_CAPABILITIES, {
    variables: { controllerId: instance?.controllerId ?? '' },
    skip: !instance?.controllerId,
  })
  const availableServerTypes = (capabilitiesData?.acpCapabilities ?? [])
    .filter((c) => c.available && c.type)
    .map((c) => c.type)

  // 失败/重试用尽节点强提醒：toast 每个状态仅一次（轮询会反复返回同一状态；
  // 同一节点先 FAILED 后 RETRY_FAILED 属不同事件，键带 status 保证各自提醒）
  const toastedFailedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!nodes) return
    for (const node of nodes) {
      if (node.status !== 'FAILED' && node.status !== 'RETRY_FAILED') continue
      const toastKey = `${node.id}:${node.status}`
      if (toastedFailedRef.current.has(toastKey)) continue
      toastedFailedRef.current.add(toastKey)
      toast.error(
        node.status === 'RETRY_FAILED'
          ? `工作流节点「${node.name}」中断自动重试用尽，需要人工介入`
          : `工作流节点「${node.name}」失败，需要人工介入`,
        { duration: 10000 },
      )
    }
  }, [nodes])

  if (loading && !instance) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      </div>
    )
  }

  if (!instance) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">工作流实例不存在</p>
      </div>
    )
  }

  const blockedNodes = instance.nodes.filter(
    (node) => node.status === 'FAILED' || node.status === 'RETRY_FAILED',
  )
  const retryFailedCount = blockedNodes.filter((node) => node.status === 'RETRY_FAILED').length
  const failedCount = blockedNodes.length - retryFailedCount

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteWorkflowInstance({ variables: { id: instance.id } })
      toast.success('工作流实例已删除')
      navigate('/sessions')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
      setDeleting(false)
      setDeleteOpen(false)
    }
  }

  const handleArchive = async () => {
    try {
      await archiveWorkflowInstance({ variables: { id: instance.id, archived: !instance.archived } })
      if (instance.archived) {
        toast.success('已取消归档')
      } else {
        toast.success('工作流实例已归档')
        navigate('/sessions')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败，请重试')
    }
  }

  return (
    <div
      className={
        viewMode === 'graph'
          ? 'flex h-full min-h-0 flex-col gap-4 p-4 md:p-6'
          : 'h-full overflow-y-auto p-4 md:p-6'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <MobileBackButton to="/sessions" />
        <h1 className="text-xl font-bold">{instance.name}</h1>
        {instance.currentNodeNames.length > 0 ? (
          instance.currentNodeNames.map((name) => (
            <Badge key={name} variant="default">
              执行中：{name}
            </Badge>
          ))
        ) : instance.lastNodeName && instance.lastNodeStatus ? (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${NODE_STATUS_BADGE[instance.lastNodeStatus]}`}
          >
            {instance.lastNodeName} · {NODE_STATUS_LABELS[instance.lastNodeStatus]}
          </span>
        ) : (
          <Badge variant="secondary">暂无执行中的节点</Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant={viewMode === 'list' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleViewModeChange('list')}
          >
            <List className="size-3.5" />
            列表
          </Button>
          <Button
            variant={viewMode === 'graph' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleViewModeChange('graph')}
          >
            <GitBranch className="size-3.5" />
            图表
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleArchive}
        >
          {instance.archived ? (
            <>
              <ArchiveRestore className="size-3.5" />
              取消归档
            </>
          ) : (
            <>
              <Archive className="size-3.5" />
              归档
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="size-3.5" />
          删除实例
        </Button>
      </div>

      {blockedNodes.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3"
        >
          <p className="text-sm font-semibold text-destructive">
            ⚠️ {blockedNodes.length} 个节点
            {retryFailedCount > 0 && failedCount > 0
              ? `（${failedCount} 个失败 / ${retryFailedCount} 个重试用尽）`
              : retryFailedCount > 0
                ? '中断自动重试用尽'
                : '失败'}
            ，流程已阻断，需要人工介入
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-destructive/90">
            {blockedNodes.map((node) => (
              <li key={node.id}>
                「{node.name}」：
                {node.status === 'RETRY_FAILED'
                  ? '中断自动重试已用尽，可重启节点，或在会话中给出指示后恢复'
                  : node.failInfo?.reason || '未提供失败原因'}
                {node.status === 'FAILED' && '（打开节点会话给出处理指示，AI 确认后会恢复节点运行）'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {viewMode === 'graph' ? (
        // 图表模式：画布占满视图区（高度随窗口自适应），右侧资源树隐藏（资源已上图）
        <div className="min-h-0 min-w-0 flex-1">
          <WorkflowGraphView
            instance={instance}
            onOpenDetail={setDetailTarget}
            onOpenSession={setSideSessionId}
          />
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <WorkflowNodeTree
            instance={instance}
            onOpenSession={setSideSessionId}
            pullRequestLinks={instance.pullRequestLinks}
            onOpenDetail={(nodeId) => setDetailTarget({ type: 'node', nodeId })}
          />
          <div className="min-w-0 space-y-4">
            <BlackboardPanel
              blackboard={instance.blackboard}
              trash={instance.blackboardTrash}
            />
            <WorkflowContextPanel
              additionalPrompts={instance.additionalPrompts}
              pullRequestLinks={instance.pullRequestLinks}
            />
          </div>
        </div>
      )}

      <NodeDetailDrawer
        open={detailTarget != null}
        onOpenChange={(open) => {
          if (!open) setDetailTarget(null)
        }}
        instance={instance}
        target={detailTarget}
        onOpenSession={(sessionId) => setSideSessionId(sessionId)}
        onRestartNode={setRestartTarget}
      />

      {restartTarget && (
        <EditInstanceNodeDialog
          open
          onOpenChange={(open) => {
            if (!open) setRestartTarget(null)
          }}
          instanceId={instance.id}
          node={restartTarget}
          controllerId={instance.controllerId}
          availableServerTypes={availableServerTypes}
          restartMode
        />
      )}

      <SessionSidePanel
        sessionId={sideSessionId}
        onClose={() => setSideSessionId(null)}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除工作流实例「{instance.name}」？</DialogTitle>
            <DialogDescription>
              删除将停止流程运转，并删除全部节点会话（含进行中的 AI 会话与 worktree）。
              实例数据会保留为已删除标记，不再出现在列表中，且无法继续流转。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? '删除中…' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
