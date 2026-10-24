import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectItemText,
} from '@/components/ui/select'
import type { AdminModelData } from '@/graphql/types'

interface ProviderOption {
  id: string
  name: string
}

interface CustomModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: ProviderOption[]
  /** 现有全局模型名（本地重名预检；服务端仍是唯一事实源） */
  existingNames?: string[]
  /** 编辑模式：传入待编辑模型；供应商与名称只读，仅可修改/清空最长上下文 */
  model?: AdminModelData | null
  /**
   * 保存回调：新增模式提交选中供应商与名称；编辑模式 providerId/name 为模型原值。
   * `contextLength` 为 null 表示未设置/清空。
   */
  onSave: (providerId: string, name: string, contextLength: number | null) => Promise<void>
}

const POSITIVE_INTEGER_ERROR = '请输入正整数'

export default function CustomModelDialog({
  open,
  onOpenChange,
  providers,
  existingNames = [],
  model = null,
  onSave,
}: CustomModelDialogProps) {
  const editing = model !== null
  const [providerId, setProviderId] = useState('')
  const [name, setName] = useState('')
  const [contextLength, setContextLength] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // R-10：仅在「打开」或「切换到另一模型」时重置表单；
  // 不能依赖 providers/model 引用（父级轮询/refetch 重渲染会清空用户正在填写的内容）。
  useEffect(() => {
    if (!open) return
    setProviderId(model?.providerId ?? providers[0]?.id ?? '')
    setName(model?.name ?? '')
    setContextLength(
      model?.contextLength !== null && model?.contextLength !== undefined
        ? String(model.contextLength)
        : '',
    )
    setError(null)
    // providers 仅用于打开时的初值；不随其引用变化重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, model?.id])

  const trimmedName = name.trim()
  const duplicateName =
    !editing && trimmedName.length > 0 && existingNames.includes(trimmedName)

  const trimmedContext = contextLength.trim()
  const contextInvalid =
    trimmedContext.length > 0 &&
    (!/^\d+$/.test(trimmedContext) || Number(trimmedContext) < 1)

  const handleSave = async () => {
    if (editing) {
      if (contextInvalid) {
        setError(POSITIVE_INTEGER_ERROR)
        return
      }
      setSaving(true)
      setError(null)
      try {
        await onSave(
          model.providerId,
          model.name,
          trimmedContext.length > 0 ? Number(trimmedContext) : null,
        )
        onOpenChange(false)
      } catch (err) {
        const message = err instanceof Error ? err.message : '操作失败，请重试'
        setError(message)
      } finally {
        setSaving(false)
      }
      return
    }

    if (!providerId || !trimmedName || duplicateName || contextInvalid) {
      if (contextInvalid) setError(POSITIVE_INTEGER_ERROR)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(
        providerId,
        trimmedName,
        trimmedContext.length > 0 ? Number(trimmedContext) : null,
      )
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败，请重试'
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  const isValid = editing
    ? !contextInvalid
    : Boolean(providerId && trimmedName && !duplicateName && !contextInvalid)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? '编辑模型' : '自定义模型'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {editing ? (
            <div className="space-y-2">
              <Label>供应商</Label>
              <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
                {model.provider?.name ?? model.providerId}
              </p>
              <Label>模型名称</Label>
              <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
                {model.name}
              </p>
            </div>
          ) : providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">请先添加供应商</p>
          ) : (
            <>
              <div className="space-y-2">
                <Label>选择供应商</Label>
                <Select value={providerId} onValueChange={(v) => setProviderId(v ?? '')}>
                  <SelectTrigger>
                    <SelectValue>
                      {providers.find((p) => p.id === providerId)?.name ?? '选择供应商'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <SelectItemText>{p.name}</SelectItemText>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="custom-model-name">模型名称</Label>
                <Input
                  id="custom-model-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如: gpt-4o-mini"
                />
                {duplicateName && (
                  <p role="alert" className="text-sm text-destructive">
                    模型名已存在
                  </p>
                )}
              </div>
            </>
          )}

          {(editing || providers.length > 0) && (
            <div className="space-y-2">
              <Label htmlFor="custom-model-context-length">最长上下文大小（token）</Label>
              <Input
                id="custom-model-context-length"
                type="text"
                inputMode="numeric"
                value={contextLength}
                onChange={(e) => setContextLength(e.target.value)}
                placeholder="留空表示未设置"
              />
              {contextInvalid && (
                <p role="alert" className="text-sm text-destructive">
                  {POSITIVE_INTEGER_ERROR}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                留空表示未设置；填写正整数（token）。
              </p>
            </div>
          )}
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!isValid || saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
