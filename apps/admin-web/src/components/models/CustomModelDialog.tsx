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
  onSave: (providerId: string, name: string) => Promise<void>
}

export default function CustomModelDialog({
  open,
  onOpenChange,
  providers,
  existingNames = [],
  onSave,
}: CustomModelDialogProps) {
  const [providerId, setProviderId] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setProviderId(providers[0]?.id ?? '')
      setName('')
      setError(null)
    }
  }, [open, providers])

  const trimmedName = name.trim()
  const duplicateName = trimmedName.length > 0 && existingNames.includes(trimmedName)

  const handleSave = async () => {
    if (!providerId || !trimmedName || duplicateName) return
    setSaving(true)
    setError(null)
    try {
      await onSave(providerId, trimmedName)
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败，请重试'
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  const isValid = providerId && trimmedName && !duplicateName

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>自定义模型</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {providers.length === 0 ? (
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
