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
import { Badge } from '@/components/ui/badge'
import {
  GET_WORKFLOW_TEMPLATES,
  CREATE_WORKFLOW_TEMPLATE,
  UPDATE_WORKFLOW_TEMPLATE,
  type WorkflowTemplateData,
  type WorkflowNodeType,
} from '@/graphql/workflow'
import {
  createEmptyNode,
  toNodeInput,
  validateTemplateNodes,
  type EditableNode,
} from './template-validation'
import { Plus, Trash2 } from 'lucide-react'

const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  HUMAN: '人类',
  AI: 'AI',
  FLAG: '旗帜',
}

const NODE_TYPE_ORDER: WorkflowNodeType[] = ['HUMAN', 'AI', 'FLAG']

interface TemplateEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑模式传入模板；创建模式传 null */
  template?: WorkflowTemplateData | null
  /** 只读查看（内置模板） */
  readOnly?: boolean
}

function templateToNodes(template: WorkflowTemplateData): EditableNode[] {
  return template.nodes.map((node) => ({
    nodeKey: node.nodeKey,
    type: node.type,
    name: node.name,
    description: node.description ?? '',
    stage: node.stage,
    promptsText: (node.prompts ?? []).join('\n'),
    artifactTitlesText: (node.artifactTitles ?? []).join('\n'),
    dependsOn: node.dependsOn,
    requiresWorktree: node.requiresWorktree,
  }))
}

/** 只读流程图预览：按阶段分组静态渲染，不引入拖拽画布 */
function FlowPreview({ nodes }: { nodes: EditableNode[] }) {
  const stages: string[] = []
  for (const node of nodes) {
    const stage = node.stage.trim() || '未命名阶段'
    if (!stages.includes(stage)) stages.push(stage)
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-3" data-testid="flow-preview">
      <div className="mb-2 text-xs font-medium text-muted-foreground">流程预览（只读）</div>
      <div className="space-y-3">
        {stages.map((stage) => (
          <div key={stage}>
            <div className="mb-1 text-xs font-semibold text-foreground">{stage}</div>
            <div className="flex flex-wrap gap-1.5">
              {nodes
                .filter((n) => (n.stage.trim() || '未命名阶段') === stage)
                .map((n, i) => (
                  <Badge key={`${n.nodeKey}-${i}`} variant="secondary">
                    {NODE_TYPE_LABELS[n.type]} · {n.name || n.nodeKey || '未命名'}
                  </Badge>
                ))}
            </div>
          </div>
        ))}
      </div>
      {nodes.some((n) => n.dependsOn.length > 0) && (
        <div className="mt-3 space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
          {nodes.flatMap((n) =>
            n.dependsOn.map((dep) => (
              <div key={`${dep}->${n.nodeKey}`}>
                {dep || '?'} → {n.nodeKey || '?'}
              </div>
            )),
          )}
        </div>
      )}
    </div>
  )
}

export default function TemplateEditorDialog({
  open,
  onOpenChange,
  template = null,
  readOnly = false,
}: TemplateEditorDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [nodes, setNodes] = useState<EditableNode[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const [createTemplate] = useMutation(CREATE_WORKFLOW_TEMPLATE)
  const [updateTemplate] = useMutation(UPDATE_WORKFLOW_TEMPLATE)

  useEffect(() => {
    if (!open) return
    setErrors([])
    setSaving(false)
    if (template) {
      setName(template.name)
      setDescription(template.description ?? '')
      setNodes(templateToNodes(template))
    } else {
      setName('')
      setDescription('')
      setNodes([createEmptyNode('HUMAN')])
    }
  }, [open, template])

  const updateNode = (index: number, patch: Partial<EditableNode>) => {
    setNodes((prev) => prev.map((n, i) => (i === index ? { ...n, ...patch } : n)))
  }

  const removeNode = (index: number) => {
    setNodes((prev) => {
      const removed = prev[index]
      return prev
        .filter((_, i) => i !== index)
        .map((n) => ({
          ...n,
          dependsOn: n.dependsOn.filter((dep) => dep !== removed.nodeKey.trim()),
        }))
    })
  }

  const toggleDependsOn = (index: number, depKey: string, checked: boolean) => {
    setNodes((prev) =>
      prev.map((n, i) => {
        if (i !== index) return n
        return {
          ...n,
          dependsOn: checked
            ? [...n.dependsOn, depKey]
            : n.dependsOn.filter((d) => d !== depKey),
        }
      }),
    )
  }

  const handleSave = async () => {
    const nextErrors: string[] = []
    if (!name.trim()) nextErrors.push('模板名称不能为空')
    nextErrors.push(...validateTemplateNodes(nodes))
    setErrors(nextErrors)
    if (nextErrors.length > 0) return

    const input = {
      name: name.trim(),
      description: description.trim() || null,
      nodes: nodes.map(toNodeInput),
    }

    setSaving(true)
    try {
      if (template) {
        await updateTemplate({
          variables: { id: template.id, input },
          refetchQueries: [{ query: GET_WORKFLOW_TEMPLATES }],
        })
        toast.success('工作流模板已更新')
      } else {
        await createTemplate({
          variables: { input },
          refetchQueries: [{ query: GET_WORKFLOW_TEMPLATES }],
        })
        toast.success('工作流模板已创建')
      }
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败，请重试'
      setErrors([message])
    } finally {
      setSaving(false)
    }
  }

  const title = readOnly
    ? '查看工作流模板'
    : template
      ? '编辑工作流模板'
      : '创建工作流模板'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            定义工作流的节点、依赖关系、提示词与产物。工作流的第一个节点必须是人类节点。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>模板名称</Label>
              <Input
                aria-label="模板名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如: 开发工作流"
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1.5">
              <Label>模板描述</Label>
              <Input
                aria-label="模板描述"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="可选"
                disabled={readOnly}
              />
            </div>
          </div>

          <div className="space-y-3">
            {nodes.map((node, index) => (
              <div key={index} className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    {NODE_TYPE_ORDER.map((t) => (
                      <Button
                        key={t}
                        size="xs"
                        variant={node.type === t ? 'default' : 'outline'}
                        aria-pressed={node.type === t}
                        disabled={readOnly}
                        onClick={() => updateNode(index, { type: t })}
                      >
                        {NODE_TYPE_LABELS[t]}
                      </Button>
                    ))}
                  </div>
                  {!readOnly && nodes.length > 1 && (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`删除节点 ${index + 1}`}
                      onClick={() => removeNode(index)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>节点标识</Label>
                    <Input
                      aria-label={`节点 ${index + 1} 标识`}
                      value={node.nodeKey}
                      onChange={(e) => updateNode(index, { nodeKey: e.target.value })}
                      placeholder="如: requirement"
                      disabled={readOnly}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>节点名称</Label>
                    <Input
                      aria-label={`节点 ${index + 1} 名称`}
                      value={node.name}
                      onChange={(e) => updateNode(index, { name: e.target.value })}
                      placeholder="如: 产品需求"
                      disabled={readOnly}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>所属阶段</Label>
                    <Input
                      aria-label={`节点 ${index + 1} 阶段`}
                      value={node.stage}
                      onChange={(e) => updateNode(index, { stage: e.target.value })}
                      placeholder="如: 方案阶段"
                      disabled={readOnly}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>节点描述</Label>
                  <Input
                    aria-label={`节点 ${index + 1} 描述`}
                    value={node.description}
                    onChange={(e) => updateNode(index, { description: e.target.value })}
                    placeholder="可选"
                    disabled={readOnly}
                  />
                </div>

                {node.type === 'AI' && (
                  <>
                    <div className="space-y-1.5">
                      <Label>提示词（每行一条）</Label>
                      <textarea
                        aria-label={`节点 ${index + 1} 提示词`}
                        className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                        value={node.promptsText}
                        onChange={(e) => updateNode(index, { promptsText: e.target.value })}
                        placeholder={'每行一条提示词\n如: 参照项目中的 AGENTS.md 产出技术方案'}
                        disabled={readOnly}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>产物标题（每行一条）</Label>
                      <textarea
                        aria-label={`节点 ${index + 1} 产物标题`}
                        className="min-h-12 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                        value={node.artifactTitlesText}
                        onChange={(e) => updateNode(index, { artifactTitlesText: e.target.value })}
                        placeholder={'每行一个产物标题\n如: 产品需求和技术方案'}
                        disabled={readOnly}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        aria-label={`节点 ${index + 1} Worktree 隔离`}
                        checked={node.requiresWorktree}
                        onCheckedChange={(checked) =>
                          updateNode(index, { requiresWorktree: checked === true })
                        }
                        disabled={readOnly}
                      />
                      <Label>该节点会话需要 Worktree 隔离</Label>
                    </div>
                  </>
                )}

                {nodes.filter((_, i) => i !== index).some((n) => n.nodeKey.trim()) && (
                  <div className="space-y-1.5">
                    <Label>依赖的上游节点</Label>
                    <div className="flex flex-wrap gap-3">
                      {nodes.map((other, otherIndex) => {
                        const depKey = other.nodeKey.trim()
                        if (otherIndex === index || !depKey) return null
                        const checked = node.dependsOn.includes(depKey)
                        return (
                          <label
                            key={`${otherIndex}-${depKey}`}
                            className="flex items-center gap-1.5 text-sm"
                          >
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={checked}
                              disabled={readOnly}
                              onChange={(e) => toggleDependsOn(index, depKey, e.target.checked)}
                            />
                            {other.name.trim() || depKey}（{depKey}）
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNodes((prev) => [...prev, createEmptyNode('AI')])}
            >
              <Plus className="size-3.5" />
              添加节点
            </Button>
          )}

          <FlowPreview nodes={nodes} />

          {errors.length > 0 && (
            <div className="space-y-1 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {errors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {readOnly ? '关闭' : '取消'}
          </Button>
          {!readOnly && (
            <Button onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
