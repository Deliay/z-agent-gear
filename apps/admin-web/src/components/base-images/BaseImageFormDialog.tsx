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
import type { BaseImageData, BaseImageInputData } from '@/graphql/types'

interface BaseImageFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialData?: BaseImageData | null
  onSave: (input: BaseImageInputData) => Promise<void>
}

export default function BaseImageFormDialog({
  open,
  onOpenChange,
  initialData,
  onSave,
}: BaseImageFormDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dockerfile, setDockerfile] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setError(null)
      setName(initialData?.name ?? '')
      setDescription(initialData?.description ?? '')
      setDockerfile(initialData?.dockerfile ?? '')
    }
  }, [open, initialData])

  const handleSave = async () => {
    if (!name.trim() || !dockerfile.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        dockerfile,
      })
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败，请重试'
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  const isValid = name.trim() && dockerfile.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initialData ? '编辑基础镜像' : '新建基础镜像'}</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="base-image-name">镜像名称</Label>
            <Input
              id="base-image-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: node-24-base"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="base-image-description">描述</Label>
            <Input
              id="base-image-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选"
            />
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="base-image-dockerfile">Dockerfile</Label>
            <textarea
              id="base-image-dockerfile"
              value={dockerfile}
              onChange={(e) => setDockerfile(e.target.value)}
              rows={12}
              spellCheck={false}
              placeholder={'FROM node:24-alpine\nWORKDIR /app\n...'}
              className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm whitespace-pre-wrap break-all outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
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
