import { useEffect, useState } from 'react'
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
import { GET_ACP_CAPABILITIES } from '@/graphql/queries'
import type { GetAcpCapabilitiesQuery } from '@/graphql/types'
import {
  GET_CONFIGURED_WORKFLOWS,
  CONFIGURE_REPO_WORKFLOW,
  type ConfigureRepoWorkflowInput,
  type RepoWorkflowTemplateData,
} from '@/graphql/workflow'
import {
  templateNodeToEditable,
  toConfiguredNodeInput,
  validateConfiguredNodes,
  type EditableNode,
} from './template-validation'
import WorkflowGraphEditor from './WorkflowGraphEditor'

interface ConfigureRepoWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 项目工作区（ControllerWorkspace）：服务端推导 controllerId 与来源路径 */
  workspaceId: string
  /** 云电脑控制器 id（固定，不提供控制器选择） */
  controllerId: string
  /** 扫描得到的模板（以 nodes 预填编辑器） */
  template: RepoWorkflowTemplateData | null
  /** 配置成功回调（刷新已配置列表） */
  onConfigured?: () => void
}

function defaultName(template: RepoWorkflowTemplateData): string {
  return template.name ?? template.fileName.replace(/\.json$/i, '')
}

/**
 * 从项目（仓库）模板配置工作流：复用 WorkflowGraphEditor + template-validation，
 * 以模板节点图预填（agentConfig 待选），名称默认模板名/文件名。
 * 提交走 configureRepoWorkflow（快照语义，服务端不回读仓库文件）。
 */
export default function ConfigureRepoWorkflowDialog({
  open,
  onOpenChange,
  workspaceId,
  controllerId,
  template,
  onConfigured,
}: ConfigureRepoWorkflowDialogProps) {
  const [name, setName] = useState('')
  const [nodes, setNodes] = useState<EditableNode[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const { data: capabilitiesData } = useQuery<GetAcpCapabilitiesQuery>(GET_ACP_CAPABILITIES, {
    variables: { controllerId },
    skip: !open || !controllerId,
  })
  const [configureRepoWorkflow] = useMutation(CONFIGURE_REPO_WORKFLOW)

  const availableAcpTypes = (capabilitiesData?.acpCapabilities ?? [])
    .filter((c) => c.available && c.type)
    .map((c) => c.type)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSaving(false)
    if (template) {
      setNodes(template.nodes.map(templateNodeToEditable))
      setName(defaultName(template))
    } else {
      setNodes([])
      setName('')
    }
  }, [open, template])

  const handleSave = async () => {
    if (!template) {
      setError('请选择一个项目工作流模板')
      return
    }
    if (!name.trim()) {
      setError('工作流名称不能为空')
      return
    }
    const nextErrors = validateConfiguredNodes(nodes)
    if (nextErrors.length > 0) {
      setError(nextErrors[0])
      return
    }

    const input: ConfigureRepoWorkflowInput = {
      workspaceId,
      fileName: template.fileName,
      name: name.trim(),
      nodes: nodes.map(toConfiguredNodeInput),
    }

    setSaving(true)
    setError(null)
    try {
      await configureRepoWorkflow({
        variables: { input },
        refetchQueries: [{ query: GET_CONFIGURED_WORKFLOWS }],
      })
      toast.success('项目工作流配置已创建')
      onConfigured?.()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="configure-repo-workflow-dialog">
        <DialogHeader>
          <DialogTitle>配置项目工作流</DialogTitle>
          {template && (
            <DialogDescription>
              以仓库模板《{template.name ?? template.fileName}》预填，配置保存后将生成独立快照，
              模板文件后续变更不会同步到此配置
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>工作流名称</Label>
            <Input
              aria-label="工作流名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如: 项目开发流程"
            />
          </div>

          <WorkflowGraphEditor
            nodes={nodes}
            onNodesChange={setNodes}
            showAgentConfig
            availableServerTypes={availableAcpTypes}
            controllerId={controllerId}
          />

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving || !template}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
