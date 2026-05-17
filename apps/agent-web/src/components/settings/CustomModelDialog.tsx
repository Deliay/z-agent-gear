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
  onSave: (providerId: string, name: string) => Promise<void>
}

export default function CustomModelDialog({
  open,
  onOpenChange,
  providers,
  onSave,
}: CustomModelDialogProps) {
  const [providerId, setProviderId] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setProviderId(providers[0]?.id ?? '')
      setName('')
    }
  }, [open, providers])

  const handleSave = async () => {
    if (!providerId || !name.trim()) return
    setSaving(true)
    try {
      await onSave(providerId, name.trim())
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const isValid = providerId && name.trim()

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
                <Select value={providerId} onValueChange={setProviderId}>
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
                <Label>模型名称</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如: gpt-4o-mini"
                />
              </div>
            </>
          )}
        </div>
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
