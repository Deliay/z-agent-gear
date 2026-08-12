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
import {
  GET_WORKFLOW_TEMPLATES,
  CREATE_WORKFLOW_TEMPLATE,
  UPDATE_WORKFLOW_TEMPLATE,
  type WorkflowTemplateData,
} from '@/graphql/workflow'
import {
  createEmptyNode,
  templateNodeToEditable,
  toNodeInput,
  validateTemplateNodes,
  type EditableNode,
} from './template-validation'
import WorkflowGraphEditor from './WorkflowGraphEditor'

interface TemplateEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑模式传入模板；创建模式传 null */
  template?: WorkflowTemplateData | null
  /** 只读查看（内置模板） */
  readOnly?: boolean
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
      setNodes(template.nodes.map(templateNodeToEditable))
    } else {
      setName('')
      setDescription('')
      setNodes([createEmptyNode('HUMAN')])
    }
  }, [open, template])

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

          <WorkflowGraphEditor nodes={nodes} onNodesChange={setNodes} readOnly={readOnly} />

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
