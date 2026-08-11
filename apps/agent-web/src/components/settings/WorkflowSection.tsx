import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
} from '@/components/ui/card'
import { GET_CONTROLLERS } from '@/graphql/queries'
import type { GetControllersQuery } from '@/graphql/types'
import {
  GET_WORKFLOW_TEMPLATES,
  GET_CONFIGURED_WORKFLOWS,
  DELETE_WORKFLOW_TEMPLATE,
  DELETE_CONFIGURED_WORKFLOW,
  type GetWorkflowTemplatesQuery,
  type GetConfiguredWorkflowsQuery,
  type WorkflowTemplateData,
  type ConfiguredWorkflowData,
} from '@/graphql/workflow'
import TemplateEditorDialog from '@/components/workflow/TemplateEditorDialog'
import ConfigureWorkflowDialog from '@/components/workflow/ConfigureWorkflowDialog'
import { Plus, Copy, RefreshCw } from 'lucide-react'

export default function WorkflowSection() {
  const { data: templatesData, loading: templatesLoading } =
    useQuery<GetWorkflowTemplatesQuery>(GET_WORKFLOW_TEMPLATES)
  const { data: configuredData } =
    useQuery<GetConfiguredWorkflowsQuery>(GET_CONFIGURED_WORKFLOWS)
  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS)

  const [deleteTemplate] = useMutation(DELETE_WORKFLOW_TEMPLATE)
  const [deleteConfigured] = useMutation(DELETE_CONFIGURED_WORKFLOW)

  const [templateEditor, setTemplateEditor] = useState<{
    open: boolean
    template: WorkflowTemplateData | null
    readOnly: boolean
  }>({ open: false, template: null, readOnly: false })

  const [configureDialog, setConfigureDialog] = useState<{
    open: boolean
    templateId: string | null
    editing: ConfiguredWorkflowData | null
  }>({ open: false, templateId: null, editing: null })

  const templates = templatesData?.workflowTemplates ?? []
  const configuredWorkflows = configuredData?.configuredWorkflows ?? []
  const controllers = controllersData?.controllers ?? []

  const controllerName = (id: string) =>
    controllers.find((c) => c.id === id)?.name ??
    controllers.find((c) => c.id === id)?.hostname ??
    id

  const latestTemplate = (id: string | null) => templates.find((t) => t.id === id)

  const handleDeleteTemplate = async (template: WorkflowTemplateData) => {
    if (!window.confirm(`确定要删除工作流模板「${template.name}」吗？`)) return
    try {
      await deleteTemplate({
        variables: { id: template.id },
        refetchQueries: [{ query: GET_WORKFLOW_TEMPLATES }],
      })
      toast.success('模板已删除')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
    }
  }

  const handleDeleteConfigured = async (workflow: ConfiguredWorkflowData) => {
    if (!window.confirm(`确定要删除已配置工作流「${workflow.name}」吗？`)) return
    try {
      await deleteConfigured({
        variables: { id: workflow.id },
        refetchQueries: [{ query: GET_CONFIGURED_WORKFLOWS }],
      })
      toast.success('已配置工作流已删除')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setTemplateEditor({ open: true, template: null, readOnly: false })}
        >
          <Plus className="size-3.5" />
          创建工作流模板
        </Button>
        <Button
          size="sm"
          onClick={() => setConfigureDialog({ open: true, templateId: null, editing: null })}
        >
          <Plus className="size-3.5" />
          配置工作流
        </Button>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-muted-foreground">工作流模板</h4>
        {templatesLoading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : templates.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            暂无工作流模板，点击「创建工作流模板」开始定义
          </div>
        ) : (
          templates.map((template) => (
            <Card key={template.id} size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {template.name}
                  <Badge variant="secondary">v{template.version}</Badge>
                  {template.isBuiltin && <Badge variant="outline">内置</Badge>}
                </CardTitle>
                {template.description && (
                  <CardDescription>{template.description}</CardDescription>
                )}
                <CardAction className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setConfigureDialog({ open: true, templateId: template.id, editing: null })
                    }
                  >
                    <Copy className="size-3" />
                    配置工作流
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      setTemplateEditor({ open: true, template, readOnly: true })
                    }
                  >
                    查看
                  </Button>
                  {!template.isBuiltin && (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          setTemplateEditor({ open: true, template, readOnly: false })
                        }
                      >
                        编辑
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => handleDeleteTemplate(template)}
                      >
                        删除
                      </Button>
                    </>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {template.nodes.length} 个节点 ·{' '}
                {Array.from(new Set(template.nodes.map((n) => n.stage))).join(' / ')}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-muted-foreground">已配置工作流</h4>
        {configuredWorkflows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            暂无已配置工作流，点击「配置工作流」从模板复制一份并开始配置
          </div>
        ) : (
          configuredWorkflows.map((workflow) => {
            const latest = latestTemplate(workflow.sourceTemplateId)
            const outdated =
              latest != null &&
              workflow.sourceTemplateVersion != null &&
              latest.version > workflow.sourceTemplateVersion
            return (
              <Card key={workflow.id} size="sm">
                <CardHeader>
                  <CardTitle>{workflow.name}</CardTitle>
                  <CardDescription>
                    Controller：{controllerName(workflow.controllerId)}
                    {workflow.sourceTemplateVersion != null &&
                      ` · 复制自模板 v${workflow.sourceTemplateVersion}`}
                  </CardDescription>
                  <CardAction className="flex gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setConfigureDialog({ open: true, templateId: null, editing: workflow })
                      }
                    >
                      编辑
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => handleDeleteConfigured(workflow)}
                    >
                      删除
                    </Button>
                  </CardAction>
                </CardHeader>
                {outdated && (
                  <CardContent>
                    <div className="flex items-center justify-between gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
                      <span>
                        模板已更新至 v{latest.version}，当前配置基于 v
                        {workflow.sourceTemplateVersion}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          setConfigureDialog({
                            open: true,
                            templateId: workflow.sourceTemplateId,
                            editing: null,
                          })
                        }
                      >
                        <RefreshCw className="size-3" />
                        重新复制
                      </Button>
                    </div>
                  </CardContent>
                )}
              </Card>
            )
          })
        )}
      </div>

      <TemplateEditorDialog
        open={templateEditor.open}
        onOpenChange={(open) => setTemplateEditor((prev) => ({ ...prev, open }))}
        template={templateEditor.template}
        readOnly={templateEditor.readOnly}
      />
      <ConfigureWorkflowDialog
        open={configureDialog.open}
        onOpenChange={(open) => setConfigureDialog((prev) => ({ ...prev, open }))}
        initialTemplateId={configureDialog.templateId}
        editing={configureDialog.editing}
      />
    </section>
  )
}
