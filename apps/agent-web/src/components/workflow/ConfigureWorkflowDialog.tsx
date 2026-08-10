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
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPopup,
  SelectItem,
  SelectItemText,
} from '@/components/ui/select'
import { GET_CONTROLLERS, GET_ACP_CAPABILITIES, GET_ACP_SERVER_OPTIONS } from '@/graphql/queries'
import type { GetControllersQuery, GetAcpCapabilitiesQuery, GetAcpServerOptionsQuery } from '@/graphql/types'
import {
  GET_WORKFLOW_TEMPLATES,
  GET_CONFIGURED_WORKFLOWS,
  CONFIGURE_WORKFLOW,
  UPDATE_CONFIGURED_WORKFLOW,
  type GetWorkflowTemplatesQuery,
  type ConfiguredWorkflowData,
  type ConfigureWorkflowInput,
} from '@/graphql/workflow'

interface AgentConfigForm {
  acpServerType: string
  modeId: string
  modelId: string
  initNewWorktree: boolean
}

/** 下拉「留空」哨兵值（Select 不接受空字符串） */
const EMPTY_OPTION_VALUE = '__default__'

/**
 * Mode/模型字段：选中 Harness 工具后由 controller 拉起空实例探测可选选项。
 * 探测到选项 → 下拉选择（含「留空」项）；探测中/失败/工具不支持 → 回退文本输入。
 */
function AgentOptionField({
  label,
  ariaLabel,
  value,
  options,
  probing,
  onChange,
}: {
  label: string
  ariaLabel: string
  value: string
  options: { id: string; name: string }[]
  probing: boolean
  onChange: (v: string) => void
}) {
  if (options.length === 0) {
    return (
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Input
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="留空则由会话内切换"
        />
        {probing && <p className="text-xs text-muted-foreground">正在拉起空实例探测可选选项…</p>}
      </div>
    )
  }

  const known = options.some((o) => o.id === value)
  const displayName = value === '' ? '留空（默认）' : (options.find((o) => o.id === value)?.name ?? value)
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        value={value || EMPTY_OPTION_VALUE}
        onValueChange={(v) => v && onChange(v === EMPTY_OPTION_VALUE ? '' : v)}
      >
        <SelectTrigger aria-label={ariaLabel}>
          <SelectValue>{displayName}</SelectValue>
          <SelectIcon />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={EMPTY_OPTION_VALUE}>
            <SelectItemText>留空（默认）</SelectItemText>
          </SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              <SelectItemText>{o.name}</SelectItemText>
            </SelectItem>
          ))}
          {value && !known && (
            <SelectItem value={value}>
              <SelectItemText>{value}（当前值）</SelectItemText>
            </SelectItem>
          )}
        </SelectPopup>
      </Select>
    </div>
  )
}

/** 单个 AI 节点的 Mode/模型字段组：按所选工具独立发起选项探测 */
function AgentNodeOptionFields({
  controllerId,
  nodeName,
  config,
  onChange,
}: {
  controllerId: string
  nodeName: string
  config: AgentConfigForm
  onChange: (patch: Partial<AgentConfigForm>) => void
}) {
  const { data, loading } = useQuery<GetAcpServerOptionsQuery>(GET_ACP_SERVER_OPTIONS, {
    variables: { controllerId, acpServerType: config.acpServerType },
    skip: !controllerId || !config.acpServerType,
  })
  const probing = Boolean(config.acpServerType) && loading
  const modes = data?.acpServerOptions.modes ?? []
  const models = data?.acpServerOptions.models ?? []
  return (
    <>
      <AgentOptionField
        label="Mode（可选）"
        ariaLabel={`${nodeName} Mode`}
        value={config.modeId}
        options={modes}
        probing={probing}
        onChange={(v) => onChange({ modeId: v })}
      />
      <AgentOptionField
        label="模型（可选）"
        ariaLabel={`${nodeName} 模型`}
        value={config.modelId}
        options={models}
        probing={probing}
        onChange={(v) => onChange({ modelId: v })}
      />
    </>
  )
}

interface ConfigureWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 预选模板（从模板卡片「配置工作流」/「重新复制」进入时传入） */
  initialTemplateId?: string | null
  /** 编辑已配置工作流时传入（仅允许修改名称/Controller/Agent 配置） */
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
  const [agentConfigs, setAgentConfigs] = useState<Record<string, AgentConfigForm>>({})
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

  // 节点定义：编辑模式使用配置快照副本，创建模式使用所选模板
  const nodeDefs = editing ? editing.nodes : (sourceTemplate?.nodes ?? [])
  const aiNodes = nodeDefs.filter((n) => n.type === 'AI')

  const availableAcpTypes = (capabilitiesData?.acpCapabilities ?? []).filter((c) => c.available)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSaving(false)
    if (editing) {
      setTemplateId(editing.sourceTemplateId ?? '')
      setName(editing.name)
      setControllerId(editing.controllerId)
      const configs: Record<string, AgentConfigForm> = {}
      for (const node of editing.nodes) {
        if (node.type === 'AI') {
          configs[node.nodeKey] = {
            acpServerType: node.agentConfig?.acpServerType ?? '',
            modeId: node.agentConfig?.modeId ?? '',
            modelId: node.agentConfig?.modelId ?? '',
            initNewWorktree: node.agentConfig?.initNewWorktree ?? false,
          }
        }
      }
      setAgentConfigs(configs)
    } else {
      setTemplateId(initialTemplateId ?? '')
      setName('')
      setControllerId('')
      setAgentConfigs({})
    }
  }, [open, editing, initialTemplateId])

  // 选择模板后，为该模板的 AI 节点初始化配置表单
  useEffect(() => {
    if (editing || !sourceTemplate) return
    setAgentConfigs((prev) => {
      const next: Record<string, AgentConfigForm> = {}
      for (const node of sourceTemplate.nodes) {
        if (node.type === 'AI') {
          next[node.nodeKey] =
            prev[node.nodeKey] ?? {
              acpServerType: '',
              modeId: '',
              modelId: '',
              initNewWorktree: false,
            }
        }
      }
      return next
    })
    if (!name) setName(sourceTemplate.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceTemplate?.id])

  const updateAgentConfig = (nodeKey: string, patch: Partial<AgentConfigForm>) => {
    setAgentConfigs((prev) => ({
      ...prev,
      [nodeKey]: { ...prev[nodeKey], ...patch },
    }))
  }

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
    for (const node of aiNodes) {
      if (!agentConfigs[node.nodeKey]?.acpServerType) {
        setError(`请为 AI 节点「${node.name}」选择 Harness 工具`)
        return
      }
    }

    const input: ConfigureWorkflowInput = {
      name: name.trim(),
      controllerId,
      nodes: nodeDefs.map((node) => ({
        nodeKey: node.nodeKey,
        agentConfig:
          node.type === 'AI'
            ? {
                acpServerType: agentConfigs[node.nodeKey].acpServerType,
                modeId: agentConfigs[node.nodeKey].modeId.trim() || null,
                modelId: agentConfigs[node.nodeKey].modelId.trim() || null,
                initNewWorktree: agentConfigs[node.nodeKey].initNewWorktree,
              }
            : null,
      })),
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
                  <SelectValue>
                    {sourceTemplate?.name ?? '选择模板'}
                  </SelectValue>
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

          {aiNodes.length > 0 && (
            <div className="space-y-3">
              <Label>AI 节点 Agent 配置</Label>
              {aiNodes.map((node) => {
                const config = agentConfigs[node.nodeKey] ?? {
                  acpServerType: '',
                  modeId: '',
                  modelId: '',
                  initNewWorktree: false,
                }
                return (
                  <div key={node.nodeKey} className="space-y-3 rounded-lg border p-3">
                    <div className="text-sm font-medium">{node.name}</div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1.5">
                        <Label>Harness 工具</Label>
                        <Select
                          value={config.acpServerType}
                          onValueChange={(v) =>
                            v && updateAgentConfig(node.nodeKey, { acpServerType: v })
                          }
                        >
                          <SelectTrigger aria-label={`${node.name} Harness 工具`}>
                            <SelectValue>{config.acpServerType || '选择工具'}</SelectValue>
                            <SelectIcon />
                          </SelectTrigger>
                          <SelectPopup>
                            {availableAcpTypes.map((c) => (
                              <SelectItem key={c.type} value={c.type}>
                                <SelectItemText>{c.type}</SelectItemText>
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        {controllerId && availableAcpTypes.length === 0 && (
                          <p className="text-xs text-muted-foreground">该 Controller 暂无可用工具</p>
                        )}
                      </div>
                      <AgentNodeOptionFields
                        controllerId={controllerId}
                        nodeName={node.name}
                        config={config}
                        onChange={(patch) => updateAgentConfig(node.nodeKey, patch)}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        aria-label={`${node.name} 初始化新 Worktree`}
                        checked={config.initNewWorktree}
                        onCheckedChange={(checked) =>
                          updateAgentConfig(node.nodeKey, { initNewWorktree: checked === true })
                        }
                      />
                      <Label>初始化新 Worktree</Label>
                    </div>
                  </div>
                )
              })}
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
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
