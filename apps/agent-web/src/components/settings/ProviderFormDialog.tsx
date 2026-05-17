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
  SelectIcon,
  SelectPopup,
  SelectItem,
  SelectItemText,
} from '@/components/ui/select'

const DEFAULT_ENDPOINTS: Record<string, string> = {
  OpenAI: 'https://api.openai.com/v1',
  Anthropic: 'https://api.anthropic.com',
}

interface ProviderFormData {
  name: string
  type: string
  endpoint: string
  credentialType: string
  credentialValue: string
}

interface ProviderFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (data: ProviderFormData) => Promise<void>
  initialData?: ProviderFormData | null
}

export default function ProviderFormDialog({
  open,
  onOpenChange,
  onSave,
  initialData,
}: ProviderFormDialogProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState('OpenAI')
  const [endpoint, setEndpoint] = useState('')
  const [credentialType] = useState('api_key')
  const [credentialValue, setCredentialValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setError(null)
      if (initialData) {
        setName(initialData.name)
        setType(initialData.type)
        setEndpoint(initialData.endpoint)
        setCredentialValue('')
      } else {
        setName('')
        setType('OpenAI')
        setEndpoint(DEFAULT_ENDPOINTS['OpenAI'])
        setCredentialValue('')
      }
    }
  }, [open, initialData])

  const handleTypeChange = (value: string) => {
    setType(value)
    if (!initialData) {
      setEndpoint(DEFAULT_ENDPOINTS[value] ?? '')
    }
  }

  const handleSave = async () => {
    if (!name.trim()) return
    if (!initialData && !credentialValue.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        name: name.trim(),
        type,
        endpoint: endpoint.trim(),
        credentialType,
        credentialValue: credentialValue.trim(),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败，请重试'
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  const isValid = name.trim() && endpoint.trim() && (initialData || credentialValue.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initialData ? '编辑供应商' : '添加供应商'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>供应商名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: My OpenAI"
            />
          </div>
          <div className="space-y-2">
            <Label>API 类型</Label>
            <Select value={type} onValueChange={handleTypeChange}>
              <SelectTrigger>
                <SelectValue>{type}</SelectValue>
                <SelectIcon />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="OpenAI">
                  <SelectItemText>OpenAI</SelectItemText>
                </SelectItem>
                <SelectItem value="Anthropic">
                  <SelectItemText>Anthropic</SelectItemText>
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>接口地址</Label>
            <Input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={DEFAULT_ENDPOINTS[type]}
            />
          </div>
          <div className="space-y-2">
            <Label>凭据类型</Label>
            <Input value="API Key" disabled />
          </div>
          <div className="space-y-2">
            <Label>凭据值</Label>
            <Input
              value={credentialValue}
              onChange={(e) => setCredentialValue(e.target.value)}
              placeholder={initialData ? '输入新 Key 以更新，留空则不修改' : 'sk-...'}
              type="password"
            />
          </div>
        </div>
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
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
