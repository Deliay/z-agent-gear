import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectItem,
  SelectItemText,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DETECT_GIT_REPO, GET_ACP_CAPABILITIES, GET_CONTROLLERS, GET_WORKSPACES } from '@/graphql/queries'
import { CREATE_WORKSPACE } from '@/graphql/mutations'
import type {
  DetectGitRepoQuery,
  GetAcpCapabilitiesQuery,
  GetControllersQuery,
  GetWorkspacesQuery,
} from '@/graphql/types'
import { HOME_OVERVIEW } from '@/graphql/home'
import {
  CONTINUE_WORKFLOW_INSTANCE,
  GET_WORKFLOW_INSTANCE,
  type NodeHarnessMappingInput,
  type WorkflowInstanceData,
} from '@/graphql/workflow'
import AddWorkspaceDialog from '@/components/settings/AddWorkspaceDialog'

interface ContinueWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instance: WorkflowInstanceData
}

interface ContinueWorkflowMutation {
  continueWorkflowInstance: { id: string; unavailableReason: string | null }
}

interface CreateWorkspaceMutation {
  createWorkspace: { id: string }
}

/**
 * 已实例化工作流接续对话框（PRD 功能点 2/3）：
 * 新控制器（在线）→ 工作路径（既有工作区或浏览目录新建）→ 创建新 Worktree（默认勾选）
 * → 逐节点 Harness 映射（列出全部未完成 AI 节点，默认沿用原 Harness 若可用）。
 */
export default function ContinueWorkflowDialog({
  open,
  onOpenChange,
  instance,
}: ContinueWorkflowDialogProps) {
  const [controllerId, setControllerId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [createWorkflowWorktree, setCreateWorkflowWorktree] = useState(true)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const unfinishedAiNodes = useMemo(
    () => instance.nodes.filter((node) => node.type === 'AI' && node.status !== 'DONE'),
    [instance.nodes],
  )

  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS, {
    fetchPolicy: 'cache-and-network',
  })
  const { data: workspacesData, refetch: refetchWorkspaces } = useQuery<GetWorkspacesQuery>(GET_WORKSPACES, {
    fetchPolicy: 'cache-and-network',
  })
  const { data: capabilitiesData } = useQuery<GetAcpCapabilitiesQuery>(GET_ACP_CAPABILITIES, {
    variables: { controllerId },
    skip: !controllerId,
  })
  const { data: gitData } = useQuery<DetectGitRepoQuery>(DETECT_GIT_REPO, {
    variables: { controllerId, workspaceId },
    skip: !controllerId || !workspaceId,
  })
  const [continueWorkflowInstance] = useMutation<ContinueWorkflowMutation>(CONTINUE_WORKFLOW_INSTANCE)
  const [createWorkspace] = useMutation<CreateWorkspaceMutation>(CREATE_WORKSPACE)

  const onlineControllers = useMemo(
    () => (controllersData?.controllers ?? []).filter((c) => c.status === 'online'),
    [controllersData],
  )
  const availableServerTypes = useMemo(
    () =>
      (capabilitiesData?.acpCapabilities ?? [])
        .filter((c) => c.available && c.type)
        .map((c) => c.type),
    [capabilitiesData],
  )
  const workspaces = useMemo(
    () =>
      (workspacesData?.workspaces ?? []).filter(
        (w) => w.controllerId === controllerId && w.isEnabled,
      ),
    [workspacesData, controllerId],
  )
  const isGitRepo = gitData?.detectGitRepo?.isGitRepo ?? false

  // 打开时重置：默认选择第一个在线控制器 + Worktree 默认勾选
  useEffect(() => {
    if (!open) return
    setControllerId(onlineControllers[0]?.id ?? '')
    setWorkspaceId('')
    setCreateWorkflowWorktree(true)
    setOverrides({})
    setError(null)
    setSubmitting(false)
    // 仅在打开瞬间按当时列表初始化；在线控制器随查询到达后由下方 effect 兜底
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 查询延迟返回时补充默认控制器
  useEffect(() => {
    if (open && !controllerId && onlineControllers.length > 0) {
      setControllerId(onlineControllers[0].id)
    }
  }, [open, controllerId, onlineControllers])

  // 能力清单到达后清理不可用覆盖值（原 Harness 不在清单时留空待选）
  useEffect(() => {
    setOverrides((prev) => {
      const next: Record<string, string> = {}
      let changed = false
      for (const [nodeId, value] of Object.entries(prev)) {
        if (availableServerTypes.includes(value)) next[nodeId] = value
        if (!availableServerTypes.includes(value)) changed = true
      }
      return changed ? next : prev
    })
  }, [availableServerTypes])

  const mappingValueOf = (nodeId: string, original?: string | null): string => {
    const override = overrides[nodeId]
    if (override !== undefined) return override
    return original && availableServerTypes.includes(original) ? original : ''
  }

  const handleControllerChange = (value: string) => {
    setControllerId(value)
    setWorkspaceId('')
    setOverrides({})
    setError(null)
  }

  const handleCreateWorkspace = async (path: string) => {
    try {
      const { data } = await createWorkspace({ variables: { input: { controllerId, path } } })
      await refetchWorkspaces()
      const newId = data?.createWorkspace?.id
      setAddWorkspaceOpen(false)
      if (newId) setWorkspaceId(newId)
    } catch (err) {
      setAddWorkspaceOpen(false)
      setError(err instanceof Error ? err.message : '创建工作路径失败，请重试')
    }
  }

  const missingHarness = unfinishedAiNodes.some(
    (node) => !mappingValueOf(node.id, node.agentConfig?.acpServerType),
  )
  // 非 Git 工作区：不创建 Worktree（勾选框置灰并展示未勾选），提交强制 false（与实例化先例同口径）
  const effectiveCreateWorktree = isGitRepo && createWorkflowWorktree
  const canSubmit =
    !submitting &&
    Boolean(controllerId) &&
    Boolean(workspaceId) &&
    !missingHarness

  const handleSubmit = async () => {
    if (!canSubmit) return
    const harnessMappings: NodeHarnessMappingInput[] = unfinishedAiNodes.map((node) => ({
      nodeId: node.id,
      acpServerType: mappingValueOf(node.id, node.agentConfig?.acpServerType),
    }))
    setSubmitting(true)
    setError(null)
    try {
      await continueWorkflowInstance({
        variables: {
          id: instance.id,
          input: {
            controllerId,
            workspaceId,
            createWorkflowWorktree: effectiveCreateWorktree,
            harnessMappings,
          },
        },
        refetchQueries: [
          { query: GET_WORKFLOW_INSTANCE, variables: { id: instance.id } },
          { query: HOME_OVERVIEW },
        ],
      })
      toast.success('工作流已接续到新控制器')
      onOpenChange(false)
    } catch (err) {
      // 服务层文案原样展示，对话框保持打开
      setError(err instanceof Error ? err.message : '接续失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>接续工作流「{instance.name}」</DialogTitle>
          <DialogDescription>
            选择新的控制器与工作路径，将实例迁移到新环境恢复流转。已完成节点与产物会完整保留；
            原控制器上的残留 Worktree 平台不做远程清理，请自行处理。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>新控制器</Label>
            <Select value={controllerId} onValueChange={(value) => handleControllerChange(value || '')}>
              <SelectTrigger className="w-full" aria-label="新控制器">
                <SelectValue>
                  {controllerId
                    ? onlineControllers.find((c) => c.id === controllerId)?.name || controllerId
                    : '选择在线控制器'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {onlineControllers.length === 0 ? (
                  <SelectItem value="" disabled>
                    暂无在线控制器
                  </SelectItem>
                ) : (
                  onlineControllers.map((controller) => (
                    <SelectItem key={controller.id} value={controller.id}>
                      <SelectItemText>{controller.name}</SelectItemText>
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>工作路径</Label>
            <div className="flex items-center gap-2">
              <Select
                value={workspaceId}
                onValueChange={(value) => setWorkspaceId(value || '')}
              >
                <SelectTrigger className="w-full" aria-label="工作路径">
                  <SelectValue>
                    {workspaceId
                      ? workspaces.find((w) => w.id === workspaceId)?.name || workspaceId
                      : '选择工作路径'}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {workspaces.length === 0 ? (
                    <SelectItem value="" disabled>
                      暂无可用工作路径
                    </SelectItem>
                  ) : (
                    workspaces.map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        <SelectItemText>{workspace.name}</SelectItemText>
                      </SelectItem>
                    ))
                  )}
                </SelectPopup>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!controllerId}
                onClick={() => setAddWorkspaceOpen(true)}
              >
                浏览目录新建…
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="continue-create-worktree"
                aria-label="创建新 Worktree"
                checked={effectiveCreateWorktree}
                disabled={!workspaceId || !isGitRepo}
                onChange={(event) => setCreateWorkflowWorktree(event.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              <Label htmlFor="continue-create-worktree" className="text-sm">
                在新工作区创建新 Worktree
              </Label>
            </div>
            {workspaceId && !isGitRepo && (
              <p className="text-xs text-muted-foreground">
                目标路径不是 Git 仓库，将不创建 Worktree 继续接续
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>节点 Harness 映射</Label>
            <p className="text-xs text-muted-foreground">
              逐一为未完成 AI 节点选择接续后使用的 Harness（原 Harness 可用时默认沿用）。
            </p>
            {unfinishedAiNodes.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                当前实例没有未完成的 AI 节点
              </p>
            ) : (
              unfinishedAiNodes.map((node) => {
                const original = node.agentConfig?.acpServerType
                const value = mappingValueOf(node.id, original)
                return (
                  <div key={node.id} className="flex flex-wrap items-center gap-2" data-testid={`harness-mapping-${node.id}`}>
                    <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      原 Harness：{original || '未设置'}
                    </span>
                    <Select
                      value={value}
                      onValueChange={(next) =>
                        setOverrides((prev) => ({ ...prev, [node.id]: next || '' }))
                      }
                    >
                      <SelectTrigger className="w-40" aria-label={`${node.name} Harness`}>
                        <SelectValue>{value || '请选择 Harness'}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {availableServerTypes.length === 0 ? (
                          <SelectItem value="" disabled>
                            暂无可用 Harness
                          </SelectItem>
                        ) : (
                          availableServerTypes.map((type) => (
                            <SelectItem key={type} value={type}>
                              <SelectItemText>{type}</SelectItemText>
                            </SelectItem>
                          ))
                        )}
                      </SelectPopup>
                    </Select>
                    {!value && availableServerTypes.length > 0 && (
                      <span className="w-full text-xs text-warning-text">原 Harness 不可用，请改选</span>
                    )}
                  </div>
                )
              })
            )}
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive-text">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? '接续中…' : '确认接续'}
          </Button>
        </DialogFooter>

        <AddWorkspaceDialog
          controllerId={controllerId}
          open={addWorkspaceOpen}
          onOpenChange={setAddWorkspaceOpen}
          onSelect={handleCreateWorkspace}
        />
      </DialogContent>
    </Dialog>
  )
}
