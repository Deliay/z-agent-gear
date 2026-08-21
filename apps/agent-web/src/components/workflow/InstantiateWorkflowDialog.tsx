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
import { DETECT_GIT_REPO, GET_ACP_CAPABILITIES } from '@/graphql/queries'
import type { DetectGitRepoQuery, GetAcpCapabilitiesQuery } from '@/graphql/types'
import {
  GET_WORKFLOW_TEMPLATES,
  GET_CONFIGURED_WORKFLOWS,
  GET_WORKFLOW_INSTANCES,
  INSTANTIATE_WORKFLOW,
  type GetWorkflowTemplatesQuery,
  type GetConfiguredWorkflowsQuery,
  type InstantiateSource,
} from '@/graphql/workflow'
import {
  configuredNodeToEditable,
  templateNodeToEditable,
  createEmptyNode,
  toConfiguredNodeInput,
  validateConfiguredNodes,
  type EditableNode,
} from './template-validation'
import WorkflowGraphEditor from './WorkflowGraphEditor'
import { cn } from '@/lib/utils'

interface InstantiateWorkflowMutation {
  instantiateWorkflow: { id: string }
}

const SOURCES: { value: InstantiateSource; label: string; desc: string }[] = [
  { value: 'CONFIGURED', label: '已配置工作流', desc: '从已配置的副本实例化' },
  { value: 'TEMPLATE', label: '模板', desc: '从模板实例化，不落地已配置工作流' },
  { value: 'BLANK', label: '空白', desc: '从零搭建节点图后实例化' },
]

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
  // 步骤 1：来源选择与目标
  const [source, setSource] = useState<InstantiateSource>('CONFIGURED')
  const [sourceId, setSourceId] = useState('')
  const [name, setName] = useState('')
  // 步骤 2：实例化前配置界面
  const [step, setStep] = useState<1 | 2>(1)
  const [nodes, setNodes] = useState<EditableNode[]>([])
  const [createWorkflowWorktree, setCreateWorkflowWorktree] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: configuredData } = useQuery<GetConfiguredWorkflowsQuery>(
    GET_CONFIGURED_WORKFLOWS,
    { variables: { controllerId } },
  )
  const { data: templatesData } = useQuery<GetWorkflowTemplatesQuery>(GET_WORKFLOW_TEMPLATES)
  const { data: gitData } = useQuery<DetectGitRepoQuery>(DETECT_GIT_REPO, {
    variables: { controllerId, workspaceId },
  })
  const { data: capabilitiesData } = useQuery<GetAcpCapabilitiesQuery>(GET_ACP_CAPABILITIES, {
    variables: { controllerId },
    skip: !controllerId,
  })
  const [instantiateWorkflow] = useMutation<InstantiateWorkflowMutation>(INSTANTIATE_WORKFLOW)

  const configuredWorkflows = configuredData?.configuredWorkflows ?? []
  const templates = templatesData?.workflowTemplates ?? []
  const availableAcpTypes = (capabilitiesData?.acpCapabilities ?? [])
    .filter((c) => c.available && c.type)
    .map((c) => c.type)

  const selectedWorkflow = configuredWorkflows.find((w) => w.id === sourceId)
  const selectedTemplate = templates.find((t) => t.id === sourceId)
  const requiresWorktree = nodes.some((n) => n.requiresWorktree)
  const isGitRepo = gitData?.detectGitRepo?.isGitRepo ?? false
  const blockedByGit = requiresWorktree && !isGitRepo

  useEffect(() => {
    if (!open) return
    setStep(1)
    setSource('CONFIGURED')
    setSourceId('')
    setName('')
    setNodes([])
    setCreateWorkflowWorktree(false)
    setError(null)
    setSubmitting(false)
  }, [open])

  const handleSourceIdSelect = (id: string, workflowName?: string) => {
    setSourceId(id)
    if (!name && workflowName) setName(workflowName)
  }

  const loadNodesForSource = (): EditableNode[] => {
    if (source === 'CONFIGURED' && selectedWorkflow) {
      return selectedWorkflow.nodes.map(configuredNodeToEditable)
    }
    if (source === 'TEMPLATE' && selectedTemplate) {
      return selectedTemplate.nodes.map(templateNodeToEditable)
    }
    return [createEmptyNode('HUMAN')]
  }

  const goToConfig = () => {
    const nextErrors: string[] = []
    if (!name.trim()) nextErrors.push('实例名称不能为空')
    if (source === 'CONFIGURED' && !sourceId) nextErrors.push('请选择一个已配置工作流')
    if (source === 'TEMPLATE' && !sourceId) nextErrors.push('请选择一个模板')
    if (nextErrors.length > 0) {
      setError(nextErrors[0])
      return
    }
    setNodes(loadNodesForSource())
    setError(null)
    setStep(2)
  }

  const handleSubmit = async () => {
    if (blockedByGit) return
    const nextErrors = validateConfiguredNodes(nodes)
    if (nextErrors.length > 0) {
      setError(nextErrors[0])
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const input = {
        source,
        configuredWorkflowId: source === 'CONFIGURED' ? sourceId : null,
        templateId: source === 'TEMPLATE' ? sourceId : null,
        controllerId,
        workspaceId,
        name: name.trim(),
        nodes: nodes.map(toConfiguredNodeInput),
        createWorkflowWorktree: isGitRepo ? createWorkflowWorktree : false,
      }
      const { data } = await instantiateWorkflow({
        variables: { input },
        refetchQueries: [{ query: GET_WORKFLOW_INSTANCES, variables: { workspaceId } }],
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{step === 1 ? '实例化工作流' : '实例化前配置'}</DialogTitle>
          <DialogDescription>
            {step === 1
              ? '选择实例化来源与目标，随后在配置界面确认节点图后创建实例。'
              : '确认节点图与 Agent 配置，提交后将创建实例。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {step === 1 ? (
            <>
              <div className="space-y-1.5">
                <Label>实例化来源</Label>
                <div className="grid gap-2 sm:grid-cols-3">
                  {SOURCES.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      aria-pressed={source === s.value}
                      className={cn(
                        'rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                        source === s.value && 'border-primary bg-accent',
                      )}
                      onClick={() => {
                        setSource(s.value)
                        setSourceId('')
                      }}
                    >
                      <div className="font-medium">{s.label}</div>
                      <div className="text-xs text-muted-foreground">{s.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {source === 'CONFIGURED' && (
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
                          aria-pressed={sourceId === workflow.id}
                          className={cn(
                            'w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                            sourceId === workflow.id && 'border-primary bg-accent',
                          )}
                          onClick={() => handleSourceIdSelect(workflow.id, workflow.name)}
                        >
                          {workflow.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {source === 'TEMPLATE' && (
                <div className="space-y-1.5">
                  <Label>工作流模板</Label>
                  <div className="space-y-1.5">
                    {templates.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        aria-pressed={sourceId === template.id}
                        className={cn(
                          'w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                          sourceId === template.id && 'border-primary bg-accent',
                        )}
                        onClick={() => handleSourceIdSelect(template.id, template.name)}
                      >
                        {template.name}（v{template.version}）
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label>实例名称</Label>
                <Input
                  aria-label="实例名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如: 用户登录功能开发"
                />
              </div>

              {error && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                实例名称：{name} · 来源：
                {SOURCES.find((s) => s.value === source)?.label}
                {source === 'CONFIGURED' && selectedWorkflow ? ` · ${selectedWorkflow.name}` : ''}
                {source === 'TEMPLATE' && selectedTemplate
                  ? ` · ${selectedTemplate.name}`
                  : ''}
              </div>

              <WorkflowGraphEditor
                nodes={nodes}
                onNodesChange={setNodes}
                showAgentConfig
                availableServerTypes={availableAcpTypes}
                controllerId={controllerId}
              />

              {isGitRepo && (
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="createWorkflowWorktree"
                    checked={createWorkflowWorktree}
                    onChange={(e) => setCreateWorkflowWorktree(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Label htmlFor="createWorkflowWorktree" className="text-sm">
                    为工作流创建独立 Worktree
                  </Label>
                </div>
              )}

              {!isGitRepo && (
                <div className="text-xs text-muted-foreground">
                  当前工作区不是 Git 仓库，无法创建 Worktree
                </div>
              )}

              {blockedByGit && (
                <div className="rounded-md bg-warning/10 p-3 text-sm text-warning">
                  当前工作区不支持 Git，无法实例化需要 Worktree 的工作流
                </div>
              )}

              {error && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          {step === 2 ? (
            <Button variant="outline" onClick={() => setStep(1)}>
              上一步
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
          )}
          {step === 1 ? (
            <Button onClick={goToConfig}>下一步</Button>
          ) : (
            <Button onClick={handleSubmit} disabled={blockedByGit || submitting}>
              {submitting ? '实例化中...' : '确认实例化'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
