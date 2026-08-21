import { useState, useEffect } from 'react'
import { useMutation } from '@apollo/client/react'
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
  GET_WORKFLOW_INSTANCE,
  UPDATE_WORKFLOW_NODE,
  RESTART_NODE,
  type WorkflowNodeData,
} from '@/graphql/workflow'
import { emptyAgentConfig, type AgentConfigForm } from './template-validation'
import { AgentConfigFields } from './WorkflowGraphEditor'

interface EditInstanceNodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string
  node: WorkflowNodeData
  controllerId: string
  /** 可用 acpServerType 列表（由实例页按 controller capabilities 传入） */
  availableServerTypes: string[]
  /** 是否为重启模式（仅允许编辑 agentConfig，保存后执行重启） */
  restartMode?: boolean
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 实例节点设置编辑弹窗：修改未开始节点（INITIALIZING/READY）的快照设置；或重启时编辑 agentConfig */
export default function EditInstanceNodeDialog({
  open,
  onOpenChange,
  instanceId,
  node,
  controllerId,
  availableServerTypes,
  restartMode = false,
}: EditInstanceNodeDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [stage, setStage] = useState('')
  const [promptsText, setPromptsText] = useState('')
  const [artifactTitlesText, setArtifactTitlesText] = useState('')
  const [requiresWorktree, setRequiresWorktree] = useState(false)
  const [agentConfig, setAgentConfig] = useState<AgentConfigForm>(emptyAgentConfig())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [updateWorkflowNode] = useMutation(UPDATE_WORKFLOW_NODE)
  const [restartNode] = useMutation(RESTART_NODE)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSaving(false)
    setName(node.name)
    setDescription(node.description ?? '')
    setStage(node.stage)
    setPromptsText((node.prompts ?? []).join('\n'))
    setArtifactTitlesText((node.artifactTitles ?? []).join('\n'))
    setRequiresWorktree(node.requiresWorktree ?? false)
    setAgentConfig(
      node.agentConfig
        ? {
            acpServerType: node.agentConfig.acpServerType,
            modeId: node.agentConfig.modeId ?? '',
            modelId: node.agentConfig.modelId ?? '',
            initNewWorktree: node.agentConfig.initNewWorktree,
          }
        : emptyAgentConfig(),
    )
  }, [open, node])

  const handleSave = async () => {
    if (restartMode) {
      // 重启模式：仅执行重启，携带新的 agentConfig
      if (!agentConfig.acpServerType) {
        setError('请为 AI 节点选择 Harness 工具')
        return
      }
      setSaving(true)
      setError(null)
      try {
        await restartNode({
          variables: {
            instanceId,
            nodeId: node.id,
            agentConfig: {
              acpServerType: agentConfig.acpServerType,
              modeId: agentConfig.modeId.trim() || null,
              modelId: agentConfig.modelId.trim() || null,
              initNewWorktree: agentConfig.initNewWorktree,
            },
          },
          refetchQueries: [{ query: GET_WORKFLOW_INSTANCE, variables: { id: instanceId } }],
        })
        toast.success(`节点「${node.name}」已重启`)
        onOpenChange(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : '重启失败，请重试')
      } finally {
        setSaving(false)
      }
      return
    }

    // 编辑模式：更新节点设置
    if (!name.trim()) {
      setError('节点名称不能为空')
      return
    }
    if (!stage.trim()) {
      setError('所属阶段不能为空')
      return
    }
    if (node.type === 'AI' && !agentConfig.acpServerType) {
      setError('请为 AI 节点选择 Harness 工具')
      return
    }
    if (node.type === 'AI' && splitLines(promptsText).length === 0) {
      setError('AI 节点至少需要一条提示词')
      return
    }

    const isAi = node.type === 'AI'
    const input = {
      name: name.trim(),
      description: description.trim() || null,
      stage: stage.trim(),
      prompts: isAi ? splitLines(promptsText) : null,
      artifactTitles: isAi ? splitLines(artifactTitlesText) : null,
      requiresWorktree: isAi ? requiresWorktree : null,
      agentConfig: isAi
        ? {
            acpServerType: agentConfig.acpServerType,
            modeId: agentConfig.modeId.trim() || null,
            modelId: agentConfig.modelId.trim() || null,
            initNewWorktree: agentConfig.initNewWorktree,
          }
        : null,
    }

    setSaving(true)
    setError(null)
    try {
      await updateWorkflowNode({
        variables: { instanceId, nodeId: node.id, input },
        refetchQueries: [{ query: GET_WORKFLOW_INSTANCE, variables: { id: instanceId } }],
      })
      toast.success('节点设置已更新')
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败，请重试'
      if (/已开始|已启动|状态/.test(message)) {
        toast.error('节点已开始，不可修改')
      } else {
        setError(message)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {restartMode ? `重启节点「${node.name}」` : `编辑节点「${node.name}」`}
          </DialogTitle>
          <DialogDescription>
            {restartMode
              ? '重启将关闭当前会话并以新配置重新拉起。修改下方配置后点击「确认重启」。'
              : '修改实例节点设置。仅未开始的节点（待开始/等待中）可编辑；已开始的节点不可修改。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!restartMode && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>节点名称</Label>
                  <Input
                    aria-label="节点名称"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="如: 产品需求"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>所属阶段</Label>
                  <Input
                    aria-label="所属阶段"
                    value={stage}
                    onChange={(e) => setStage(e.target.value)}
                    placeholder="如: 方案阶段"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>节点标识</Label>
                  <Input aria-label="节点标识" value={node.nodeKey} disabled />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>节点描述</Label>
                <Input
                  aria-label="节点描述"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="可选"
                />
              </div>
            </>
          )}

          {node.type === 'AI' && (
            <>
              {!restartMode && (
                <>
                  <div className="space-y-1.5">
                    <Label>提示词（每行一条）</Label>
                    <textarea
                      aria-label="提示词"
                      className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      value={promptsText}
                      onChange={(e) => setPromptsText(e.target.value)}
                      placeholder={'每行一条提示词\n如: 参照项目中的 AGENTS.md 产出技术方案'}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>产物标题（每行一条）</Label>
                    <textarea
                      aria-label="产物标题"
                      className="min-h-12 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      value={artifactTitlesText}
                      onChange={(e) => setArtifactTitlesText(e.target.value)}
                      placeholder={'每行一个产物标题\n如: 产品需求和技术方案'}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label="Worktree 隔离"
                      checked={requiresWorktree}
                      onCheckedChange={(checked) => setRequiresWorktree(checked === true)}
                    />
                    <Label>该节点会话需要 Worktree 隔离</Label>
                  </div>
                </>
              )}
              <AgentConfigFields
                nodeName={node.name}
                config={agentConfig}
                availableServerTypes={availableServerTypes}
                controllerId={controllerId}
                readOnly={false}
                onChange={(patch) => setAgentConfig((prev) => ({ ...prev, ...patch }))}
              />
            </>
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
            {saving ? (restartMode ? '重启中...' : '保存中...') : (restartMode ? '确认重启' : '保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
