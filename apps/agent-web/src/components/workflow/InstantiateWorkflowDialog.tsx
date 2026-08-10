import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DETECT_GIT_REPO } from '@/graphql/queries'
import type { DetectGitRepoQuery } from '@/graphql/types'
import {
  GET_CONFIGURED_WORKFLOWS,
  GET_WORKFLOW_INSTANCES,
  INSTANTIATE_WORKFLOW,
  type GetConfiguredWorkflowsQuery,
} from '@/graphql/workflow'

interface InstantiateWorkflowMutation {
  instantiateWorkflow: { id: string }
}
import { cn } from '@/lib/utils'

interface InstantiateWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  controllerId: string
}

export default function InstantiateWorkflowDialog({
  open,
  onOpenChange,
  workspaceId,
  controllerId,
}: InstantiateWorkflowDialogProps) {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: configuredData } = useQuery<GetConfiguredWorkflowsQuery>(
    GET_CONFIGURED_WORKFLOWS,
    { variables: { controllerId } },
  )
  const { data: gitData } = useQuery<DetectGitRepoQuery>(DETECT_GIT_REPO, {
    variables: { controllerId, workspaceId },
  })
  const [instantiateWorkflow] = useMutation<InstantiateWorkflowMutation>(INSTANTIATE_WORKFLOW)

  const configuredWorkflows = configuredData?.configuredWorkflows ?? []
  const selected = configuredWorkflows.find((w) => w.id === selectedId)
  const requiresWorktree = selected?.nodes.some((n) => n.requiresWorktree) ?? false
  const isGitRepo = gitData?.detectGitRepo?.isGitRepo ?? false
  const blockedByGit = requiresWorktree && !isGitRepo

  useEffect(() => {
    if (!open) return
    setSelectedId('')
    setName('')
    setError(null)
    setSubmitting(false)
  }, [open])

  const handleSelect = (id: string, workflowName: string) => {
    setSelectedId(id)
    if (!name) setName(workflowName)
  }

  const handleSubmit = async () => {
    if (!selectedId || blockedByGit) return
    if (!name.trim()) {
      setError('实例名称不能为空')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const { data } = await instantiateWorkflow({
        variables: { configuredWorkflowId: selectedId, workspaceId, name: name.trim() },
        refetchQueries: [
          { query: GET_WORKFLOW_INSTANCES, variables: { workspaceId } },
        ],
      })
      const instanceId = data?.instantiateWorkflow?.id
      toast.success('工作流实例已创建')
      onOpenChange(false)
      if (instanceId) navigate(`/workflows/${instanceId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '实例化失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>实例化工作流</DialogTitle>
          <DialogDescription>
            从「已配置工作流」中选择一个并在当前工作区下实例化。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>已配置工作流</Label>
            {configuredWorkflows.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                暂无已配置工作流，请先在「设置 → 工作流」中配置
              </p>
            ) : (
              <div className="space-y-1.5">
                {configuredWorkflows.map((workflow) => (
                  <button
                    key={workflow.id}
                    type="button"
                    aria-pressed={selectedId === workflow.id}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                      selectedId === workflow.id && 'border-primary bg-accent',
                    )}
                    onClick={() => handleSelect(workflow.id, workflow.name)}
                  >
                    {workflow.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>实例名称</Label>
            <Input
              aria-label="实例名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如: 用户登录功能开发"
            />
          </div>

          {blockedByGit && (
            <div className="rounded-md bg-warning/10 p-3 text-sm text-warning">
              当前工作区不支持 Git，无法实例化需要 Worktree 的工作流
            </div>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedId || blockedByGit || submitting}
          >
            {submitting ? '实例化中...' : '实例化'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
