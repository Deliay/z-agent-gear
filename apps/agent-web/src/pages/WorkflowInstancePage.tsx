import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  GET_WORKFLOW_INSTANCE,
  DELETE_WORKFLOW_INSTANCE,
  ARCHIVE_WORKFLOW_INSTANCE,
  RENAME_WORKFLOW_INSTANCE,
  type GetWorkflowInstanceQuery,
  type WorkflowNodeData,
} from '@/graphql/workflow'
import { GET_ACP_CAPABILITIES } from '@/graphql/queries'
import type { GetAcpCapabilitiesQuery } from '@/graphql/types'
import WorkflowTopBar from '@/components/workflow/WorkflowTopBar'
import WorkflowAlertBanners from '@/components/workflow/WorkflowAlertBanners'
import WorkflowInspectorDrawer from '@/components/workflow/WorkflowInspectorDrawer'
import WorkflowNodeTree from '@/components/workflow/WorkflowNodeTree'
import WorkflowGraphView from '@/components/workflow/WorkflowGraphView'
import EditInstanceNodeDialog from '@/components/workflow/EditInstanceNodeDialog'
import BlackboardPanel from '@/components/workflow/BlackboardPanel'
import WorkflowContextPanel from '@/components/workflow/WorkflowContextPanel'
import SessionSidePanel from '@/components/workflow/SessionSidePanel'
import NodeDetailDrawer, { type NodeDetailTarget } from '@/components/workflow/NodeDetailDrawer'
import ContinueWorkflowDialog from '@/components/workflow/ContinueWorkflowDialog'
import { useUserEventStream } from '@/hooks/useUserEventStream'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

/** 实例名称长度上限（与服务端 WORKFLOW_NAME_MAX_LENGTH 同口径） */
const WORKFLOW_NAME_MAX_LENGTH = 64

/** 前端名称校验（仅提示，服务端为权威）：返回错误文案或 null */
function validateName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '名称不能为空'
  if (name.length > WORKFLOW_NAME_MAX_LENGTH) return `名称最多 ${WORKFLOW_NAME_MAX_LENGTH} 个字符`
  return null
}

export default function WorkflowInstancePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [sideSessionId, setSideSessionId] = useState<string | null>(null)
  // 节点/资源详情抽屉：图表与列表共用，状态提升到页面层（轮询刷新不重置）
  const [detailTarget, setDetailTarget] = useState<NodeDetailTarget | null>(null)
  // 图表模式下的实例资源右侧抽屉（黑板/垃圾桶/关联 PR/追加提示词）
  const [inspectorOpen, setInspectorOpen] = useState(false)
  // 抽屉内「重启节点」：复用实例节点对话框 restartMode（页面级持有，列表视图另有自己的对话框）
  const [restartTarget, setRestartTarget] = useState<WorkflowNodeData | null>(null)
  // 接续对话框：列表「接续」入口经 `?continue=1` 深链打开
  const [continueOpen, setContinueOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteWorkflowInstance] = useMutation(DELETE_WORKFLOW_INSTANCE)
  const [archiveWorkflowInstance] = useMutation(ARCHIVE_WORKFLOW_INSTANCE)
  const [renameWorkflowInstance] = useMutation(RENAME_WORKFLOW_INSTANCE)
  // 改名对话框：名称草稿 + 服务端错误文案（前端校验只提示不替代服务端）
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  // 视图切换：List/Graph，localStorage 持久化
  const [viewMode, setViewMode] = useState<'list' | 'graph'>(() => {
    const saved = localStorage.getItem('workflow-view-mode')
    return (saved === 'graph' || saved === 'list') ? saved : 'list'
  })

  const handleViewModeChange = (mode: 'list' | 'graph') => {
    setViewMode(mode)
    localStorage.setItem('workflow-view-mode', mode)
  }

  const { data, loading, refetch } = useQuery<GetWorkflowInstanceQuery>(GET_WORKFLOW_INSTANCE, {
    variables: { id: id ?? '' },
    skip: !id,
    pollInterval: 5000,
    // Apollo v4 默认 notifyOnNetworkStatusChange=true：轮询会反复置 loading，
    // 导致整页卸载成 spinner、打断用户输入；轮询期间保持渲染现有内容。
    notifyOnNetworkStatusChange: false,
  })

  // 待审批感叹号近实时刷新：任意 session_interaction 事件触发实例查询 refetch（5s 轮询兜底）
  useUserEventStream({
    enabled: true,
    onSessionInteraction: () => {
      void refetch();
    },
  })

  const instance = data?.workflowInstance
  const nodes = instance?.nodes
  const unavailable = Boolean(instance?.unavailableReason)

  // `?continue=1` 深链：实例不可用时自动打开接续对话框
  useEffect(() => {
    if (searchParams.get('continue') === '1' && instance?.unavailableReason) {
      setContinueOpen(true)
    }
  }, [searchParams, instance?.unavailableReason])

  const handleContinueOpenChange = (open: boolean) => {
    setContinueOpen(open)
    if (!open && searchParams.get('continue') === '1') {
      const next = new URLSearchParams(searchParams)
      next.delete('continue')
      setSearchParams(next, { replace: true })
    }
  }

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
  const selectedNodeId = detailTarget?.type === 'node' ? detailTarget.nodeId : null
  const sideSessionNode = sideSessionId
    ? instance.nodes.find((node) => node.sessionId === sideSessionId) ?? null
    : null

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

  /** 打开改名对话框：预填当前名称并清空上次错误 */
  const handleOpenRename = () => {
    setRenameDraft(instance.name)
    setRenameError(null)
    setRenameOpen(true)
  }

  const handleRename = async () => {
    const error = validateName(renameDraft)
    if (error) {
      setRenameError(error)
      return
    }
    setRenaming(true)
    setRenameError(null)
    try {
      await renameWorkflowInstance({
        variables: { id: instance.id, name: renameDraft.trim() },
      })
      toast.success('实例名称已更新')
      setRenameOpen(false)
    } catch (err) {
      // 服务端文案原样展示（invalid workflow name / Workflow instance is deleted 等）
      setRenameError(err instanceof Error ? err.message : '重命名失败，请重试')
    } finally {
      setRenaming(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <WorkflowTopBar
        instance={instance}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        onOpenRename={handleOpenRename}
        onOpenInspector={() => setInspectorOpen(true)}
        onArchive={handleArchive}
        onOpenDelete={() => setDeleteOpen(true)}
      />

      <WorkflowAlertBanners
        instance={instance}
        blockedNodes={blockedNodes}
        onOpenContinue={() => handleContinueOpenChange(true)}
        onSelectNode={(nodeId) => setDetailTarget({ type: 'node', nodeId })}
        onOpenSession={(node) => {
          if (node.sessionId) setSideSessionId(node.sessionId)
        }}
      />

      {viewMode === 'graph' ? (
        <div className="min-h-0 min-w-0 flex-1 p-4 md:p-6">
          <WorkflowGraphView
            instance={instance}
            unavailable={unavailable}
            selectedNodeId={selectedNodeId}
            onOpenDetail={setDetailTarget}
            onOpenSession={setSideSessionId}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
            <WorkflowNodeTree
              instance={instance}
              unavailable={unavailable}
              onOpenSession={setSideSessionId}
              pullRequestLinks={instance.pullRequestLinks}
              onOpenDetail={(nodeId) => setDetailTarget({ type: 'node', nodeId })}
              pendingInteractionSessionIds={instance.pendingInteractionSessionIds ?? []}
            />
            <div className="min-w-0 space-y-3">
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
        </div>
      )}

      <WorkflowInspectorDrawer
        open={inspectorOpen}
        onOpenChange={setInspectorOpen}
        instance={instance}
      />

      <NodeDetailDrawer
        open={detailTarget != null}
        onOpenChange={(open) => {
          if (!open) setDetailTarget(null)
        }}
        instance={instance}
        unavailable={unavailable}
        target={detailTarget}
        onOpenSession={(sessionId) => setSideSessionId(sessionId)}
        onRestartNode={unavailable ? undefined : setRestartTarget}
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
        nodeName={sideSessionNode?.name}
        nodeStatus={sideSessionNode?.status}
        onClose={() => setSideSessionId(null)}
      />

      {continueOpen && (
        <ContinueWorkflowDialog
          open={continueOpen}
          onOpenChange={handleContinueOpenChange}
          instance={instance}
        />
      )}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名实例</DialogTitle>
            <DialogDescription>
              新名称将同步展示在工作流列表与详情页；trim 后需为 1~
              {WORKFLOW_NAME_MAX_LENGTH} 个字符。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="workflow-rename-input" className="text-xs text-muted-foreground">
              实例名称
            </label>
            <Input
              id="workflow-rename-input"
              aria-label="实例名称"
              value={renameDraft}
              aria-invalid={renameError != null || validateName(renameDraft) != null}
              onChange={(event) => {
                setRenameDraft(event.target.value)
                setRenameError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !renaming && !validateName(renameDraft)) {
                  void handleRename()
                }
              }}
            />
            {(renameError ?? validateName(renameDraft)) && (
              <p className="text-xs text-destructive-text">
                {renameError ?? validateName(renameDraft)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)} disabled={renaming}>
              取消
            </Button>
            <Button onClick={handleRename} disabled={renaming || validateName(renameDraft) != null}>
              {renaming ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
