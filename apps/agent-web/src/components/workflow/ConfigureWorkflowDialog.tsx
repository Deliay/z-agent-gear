import { useState, useEffect } from 'react'
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPopup,
  SelectItem,
  SelectItemText,
} from '@/components/ui/select'
import { GET_CONTROLLERS, GET_ACP_CAPABILITIES } from '@/graphql/queries'
import type { GetControllersQuery, GetAcpCapabilitiesQuery } from '@/graphql/types'
import {
  GET_WORKFLOW_TEMPLATES,
  GET_CONFIGURED_WORKFLOWS,
  CONFIGURE_WORKFLOW,
  UPDATE_CONFIGURED_WORKFLOW,
  type GetWorkflowTemplatesQuery,
  type ConfiguredWorkflowData,
  type ConfigureWorkflowInput,
} from '@/graphql/workflow'
import {
  configuredNodeToEditable,
  templateNodeToEditable,
  toConfiguredNodeInput,
  validateConfiguredNodes,
  type EditableNode,
} from './template-validation'
import WorkflowGraphEditor from './WorkflowGraphEditor'

interface ConfigureWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 预选模板（从模板卡片「配置工作流」/「重新复制」进入时传入） */
  initialTemplateId?: string | null
  /** 编辑已配置工作流时传入（允许编辑完整节点图） */
  editing?: ConfiguredWorkflowData | null
}

export default function ConfigureWorkflowDialog({
  open,
  onOpenChange,
  initialTemplateId = null,
  editing = null,
}: ConfigureWorkflowDialogProps) {
  const [templateId, setTemplateId] = useState<string>('')
  const [name, setName] = useState('')
  const [controllerId, setControllerId] = useState('')
  const [nodes, setNodes] = useState<EditableNode[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const { data: templatesData } = useQuery<GetWorkflowTemplatesQuery>(GET_WORKFLOW_TEMPLATES)
  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS)
  const { data: capabilitiesData } = useQuery<GetAcpCapabilitiesQuery>(GET_ACP_CAPABILITIES, {
    variables: { controllerId },
    skip: !controllerId,
  })

  const [configureWorkflow] = useMutation(CONFIGURE_WORKFLOW)
  const [updateConfiguredWorkflow] = useMutation(UPDATE_CONFIGURED_WORKFLOW)

  const templates = templatesData?.workflowTemplates ?? []
  const onlineControllers = (controllersData?.controllers ?? []).filter(
    (c) => c.status === 'online',
  )

  const sourceTemplate = editing
    ? templates.find((t) => t.id === editing.sourceTemplateId)
    : templates.find((t) => t.id === templateId)

  const availableAcpTypes = (capabilitiesData?.acpCapabilities ?? []).filter(
    (c) => c.available && c.type,
  ).map((c) => c.type)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSaving(false)
    if (editing) {
      setTemplateId(editing.sourceTemplateId ?? '')
      setName(editing.name)
      setControllerId(editing.controllerId)
      setNodes(editing.nodes.map(configuredNodeToEditable))
    } else {
      setTemplateId(initialTemplateId ?? '')
      setName('')
      setControllerId('')
      setNodes(initialTemplateId ? [] : [])
    }
  }, [open, editing, initialTemplateId])

  // 创建模式：模板确定后载入模板节点图作为初值。
  // 依赖 open：对话框 dismiss 后再次打开时需重新加载模板节点图（同模板 sourceTemplate?.id 不变，
  // 仅靠 id 依赖无法重新触发；加入 open 确保每次打开都重置并载入）。
  useEffect(() => {
    if (editing || !sourceTemplate) return
    setNodes(sourceTemplate.nodes.map(templateNodeToEditable))
    if (!name) setName(sourceTemplate.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceTemplate?.id])

  const handleSave = async () => {
    if (!name.trim()) {
      setError('工作流名称不能为空')
      return
    }
    if (!controllerId) {
      setError('请选择一个在线 Controller')
      return
    }
    if (!editing && !templateId) {
      setError('请选择一个工作流模板')
      return
    }
    const nextErrors = validateConfiguredNodes(nodes)
    if (nextErrors.length > 0) {
      setError(nextErrors[0])
      return
    }

    const input: ConfigureWorkflowInput = {
      name: name.trim(),
      controllerId,
      nodes: nodes.map(toConfiguredNodeInput),
    }

    setSaving(true)
    setError(null)
    try {
      if (editing) {
        await updateConfiguredWorkflow({
          variables: { id: editing.id, input },
          refetchQueries: [{ query: GET_CONFIGURED_WORKFLOWS }],
        })
        toast.success('已配置工作流已更新')
      } else {
        await configureWorkflow({
          variables: { templateId, input },
          refetchQueries: [{ query: GET_CONFIGURED_WORKFLOWS }],
        })
        toast.success('工作流配置已创建')
      }
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑已配置工作流' : '配置工作流'}</DialogTitle>
          {sourceTemplate && (
            <DialogDescription>
              本配置复制自模板《{sourceTemplate.name}》v
              {editing ? (editing.sourceTemplateVersion ?? sourceTemplate.version) : sourceTemplate.version}
              ，模板后续更新不会同步到此配置
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4">
          {!editing && (
            <div className="space-y-1.5">
              <Label>工作流模板</Label>
              <Select value={templateId} onValueChange={(v) => v && setTemplateId(v)}>
                <SelectTrigger aria-label="工作流模板">
                  <SelectValue>{sourceTemplate?.name ?? '选择模板'}</SelectValue>
                  <SelectIcon />
                </SelectTrigger>
                <SelectPopup>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <SelectItemText>
                        {t.name}（v{t.version}）
                      </SelectItemText>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>工作流名称</Label>
              <Input
                aria-label="工作流名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如: 开发工作流（本机）"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Controller（在线）</Label>
              <Select value={controllerId} onValueChange={(v) => v && setControllerId(v)}>
                <SelectTrigger aria-label="Controller">
                  <SelectValue>
                    {onlineControllers.find((c) => c.id === controllerId)?.name ??
                      onlineControllers.find((c) => c.id === controllerId)?.hostname ??
                      '选择 Controller'}
                  </SelectValue>
                  <SelectIcon />
                </SelectTrigger>
                <SelectPopup>
                  {onlineControllers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <SelectItemText>{c.name || c.hostname}</SelectItemText>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {onlineControllers.length === 0 && (
                <p className="text-xs text-muted-foreground">暂无在线 Controller</p>
              )}
            </div>
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
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
