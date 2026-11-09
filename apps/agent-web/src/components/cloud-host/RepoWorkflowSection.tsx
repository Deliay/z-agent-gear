import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { GET_CONTROLLER_WORKSPACES } from '@/graphql/queries'
import type { ControllerWorkspaceData, GetControllerWorkspacesQuery } from '@/graphql/types'
import {
  GET_CONFIGURED_WORKFLOWS,
  DELETE_CONFIGURED_WORKFLOW,
  REPO_WORKFLOW_TEMPLATES,
  type ConfiguredWorkflowData,
  type GetConfiguredWorkflowsQuery,
  type RepoWorkflowTemplateData,
} from '@/graphql/workflow'
import { isRepoTemplateScanSupported } from '@/lib/repo-workflow'
import ConfigureRepoWorkflowDialog from '@/components/workflow/ConfigureRepoWorkflowDialog'

interface RepoWorkflowTemplatesQuery {
  repoWorkflowTemplates: RepoWorkflowTemplateData[]
}

export interface RepoWorkflowSectionProps {
  controllerId: string
  /** 控制器上报版本（agent-gear 2.18.0 起支持项目模板扫描） */
  controllerVersion?: string | null
  /** 云电脑运行态（非 RUNNING 整区块只读） */
  cloudHost: {
    status: string
    deletedAt?: string | null
    defaultWorkspace?: string | null
  }
  /** 配置/删除后通知父级刷新 */
  onChanged?: () => void
}

/**
 * 云电脑配置页「工作流」区块：
 * 项目工作区选择 → 扫描仓库 `.zag/workflow/templates/*.json` → 模板列表（合法可配置、不合法标示原因）→
 * 已配置的项目来源工作流列表（sourceKind=REPO，展示来源路径，可删除）。
 */
export default function RepoWorkflowSection({
  controllerId,
  controllerVersion,
  cloudHost,
  onChanged,
}: RepoWorkflowSectionProps) {
  const [workspaceId, setWorkspaceId] = useState<string>('')
  const [configureTemplate, setConfigureTemplate] = useState<RepoWorkflowTemplateData | null>(null)
  const [configureOpen, setConfigureOpen] = useState(false)

  const running = cloudHost.status === 'RUNNING' && !cloudHost.deletedAt
  const versionSupported = isRepoTemplateScanSupported(controllerVersion)

  const { data: workspacesData, loading: workspacesLoading } = useQuery<GetControllerWorkspacesQuery>(
    GET_CONTROLLER_WORKSPACES,
    { variables: { controllerId } },
  )
  const workspaces = useMemo(
    () => workspacesData?.controllerWorkspaces ?? [],
    [workspacesData],
  )

  // 默认匹配云电脑 defaultWorkspace；未命中回退第一个工作区
  useEffect(() => {
    if (workspaces.length === 0) {
      setWorkspaceId('')
      return
    }
    if (workspaceId && workspaces.some((ws) => ws.id === workspaceId)) return
    const preferred = workspaces.find((ws) => ws.path === cloudHost.defaultWorkspace)
    setWorkspaceId((preferred ?? workspaces[0]).id)
  }, [workspaces, workspaceId, cloudHost.defaultWorkspace])

  const scanEnabled = running && versionSupported && Boolean(workspaceId)
  const {
    data: templatesData,
    loading: templatesLoading,
    refetch: refetchTemplates,
  } = useQuery<RepoWorkflowTemplatesQuery>(REPO_WORKFLOW_TEMPLATES, {
    variables: { workspaceId },
    skip: !scanEnabled,
    fetchPolicy: 'cache-and-network',
  })

  const { data: configuredData, refetch: refetchConfigured } = useQuery<GetConfiguredWorkflowsQuery>(
    GET_CONFIGURED_WORKFLOWS,
    { variables: { controllerId } },
  )
  const [deleteConfigured] = useMutation(DELETE_CONFIGURED_WORKFLOW)

  const repoWorkflows: ConfiguredWorkflowData[] = useMemo(
    () => (configuredData?.configuredWorkflows ?? []).filter((w) => w.sourceKind === 'REPO'),
    [configuredData],
  )

  const templates = templatesData?.repoWorkflowTemplates ?? []

  const handleDelete = async (workflow: ConfiguredWorkflowData) => {
    if (!window.confirm(`确定要删除已配置工作流「${workflow.name}」吗？`)) return
    try {
      await deleteConfigured({
        variables: { id: workflow.id },
        refetchQueries: [{ query: GET_CONFIGURED_WORKFLOWS }],
      })
      await refetchConfigured()
      onChanged?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
    }
  }

  const openConfigure = (template: RepoWorkflowTemplateData) => {
    setConfigureTemplate(template)
    setConfigureOpen(true)
  }

  return (
    <div className="min-w-0 space-y-4" data-testid="repo-workflow-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          读取项目仓库 <code>.zag/workflow/templates/</code> 下的 JSON 工作流模板。
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!scanEnabled || templatesLoading}
          onClick={() => void refetchTemplates()}
        >
          <RefreshCw className="size-3.5" />
          重新检测
        </Button>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground" htmlFor="repo-workflow-workspace">
          项目工作区
        </label>
        <select
          id="repo-workflow-workspace"
          aria-label="项目工作区"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          disabled={workspaces.length === 0}
        >
          {workspaces.length === 0 ? (
            <option value="">暂无工作区</option>
          ) : (
            workspaces.map((ws: ControllerWorkspaceData) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}（{ws.path}）
              </option>
            ))
          )}
        </select>
      </div>

      {!running ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          云电脑运行中才可检测与配置
        </div>
      ) : !versionSupported ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          升级云电脑工作组件后可检测项目模板
        </div>
      ) : (
        <div className="space-y-2" data-testid="repo-workflow-templates">
          {workspacesLoading || templatesLoading ? (
            <div className="text-sm text-muted-foreground">检测中...</div>
          ) : templates.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              未检测到项目工作流模板
            </div>
          ) : (
            templates.map((template) => (
              <div
                key={template.fileName}
                className={`rounded-lg border p-3 ${template.valid ? '' : 'opacity-60'}`}
                data-testid={`repo-template-${template.fileName}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{template.name ?? template.fileName}</span>
                  <Badge variant="outline">{template.fileName}</Badge>
                  {template.nodeCount != null && (
                    <span className="text-xs text-muted-foreground">{template.nodeCount} 个节点</span>
                  )}
                  {template.valid && (
                    <Button
                      size="sm"
                      className="ml-auto"
                      onClick={() => openConfigure(template)}
                    >
                      配置
                    </Button>
                  )}
                </div>
                {!template.valid && template.errors[0] && (
                  <p className="mt-1 text-xs text-destructive">{template.errors[0]}</p>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">已配置工作流（项目）</h3>
        {repoWorkflows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            暂无项目来源的已配置工作流
          </div>
        ) : (
          repoWorkflows.map((workflow) => (
            <div
              key={workflow.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
              data-testid={`repo-configured-${workflow.id}`}
            >
              <span className="font-medium">{workflow.name}</span>
              <Badge variant="outline">项目模板</Badge>
              {workflow.sourceRepoPath && (
                <span className="min-w-0 break-all text-xs text-muted-foreground">
                  {workflow.sourceRepoPath}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-destructive"
                onClick={() => void handleDelete(workflow)}
              >
                删除
              </Button>
            </div>
          ))
        )}
      </div>

      <ConfigureRepoWorkflowDialog
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        workspaceId={workspaceId}
        controllerId={controllerId}
        template={configureTemplate}
        onConfigured={() => {
          void refetchConfigured()
          onChanged?.()
        }}
      />
    </div>
  )
}
