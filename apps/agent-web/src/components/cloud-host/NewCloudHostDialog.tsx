import { useEffect, useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { CREATE_CLOUD_HOST } from '../../graphql/mutations'
import type {
  CloudHostCapabilitiesData,
  CloudHostData,
  CreateCloudHostMutation,
  HarnessType,
} from '../../graphql/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface NewCloudHostDialogProps {
  open: boolean
  capabilities: CloudHostCapabilitiesData
  /** 已有 STARTING/RUNNING/STOPPING 云电脑时禁用提交 */
  hasActiveCloudHost?: boolean
  onClose: () => void
  onCreated: (cloudHost: CloudHostData) => void
}

const HARNESS_LABELS: Record<string, string> = {
  OPENCODE: 'OpenCode',
}

const NAME_MAX_LENGTH = 64

function harnessLabel(harness: HarnessType): string {
  return HARNESS_LABELS[harness] ?? harness
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return '创建云电脑失败，请稍后重试'
}

/**
 * 新建云电脑对话框：名称（trim 1~64）+ harness 多选（≥1）。
 * 一期无存储/会话导入参数；选择 1 个 harness 时服务端会自动创建默认会话。
 */
export default function NewCloudHostDialog({
  open,
  capabilities,
  hasActiveCloudHost = false,
  onClose,
  onCreated,
}: NewCloudHostDialogProps) {
  const [name, setName] = useState('')
  const [selectedHarnesses, setSelectedHarnesses] = useState<HarnessType[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createCloudHost] = useMutation<CreateCloudHostMutation>(CREATE_CLOUD_HOST)

  useEffect(() => {
    if (open) {
      setName('')
      setSelectedHarnesses([])
      setSubmitting(false)
      setError(null)
    }
  }, [open])

  const trimmedName = name.trim()
  const nameError = trimmedName.length === 0
    ? '请输入云电脑名称'
    : trimmedName.length > NAME_MAX_LENGTH
      ? `名称不能超过 ${NAME_MAX_LENGTH} 个字符`
      : null
  const harnessError = selectedHarnesses.length === 0 ? '请至少选择一种 Harness' : null
  const featureDisabled = !capabilities.enabled
  const submitDisabled =
    submitting || featureDisabled || hasActiveCloudHost || Boolean(nameError) || Boolean(harnessError)

  const toggleHarness = (harness: HarnessType, checked: boolean) => {
    setSelectedHarnesses((prev) =>
      checked ? [...prev.filter((item) => item !== harness), harness] : prev.filter((item) => item !== harness),
    )
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitDisabled) return

    setSubmitting(true)
    setError(null)
    try {
      const { data } = await createCloudHost({
        variables: { input: { name: trimmedName, harnessTypes: selectedHarnesses } },
      })
      const created = data?.createCloudHost
      if (created) {
        onCreated(created)
      }
    } catch (err) {
      // 服务端错误文案原样展示（name is required / too many cloud hosts / ...）
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const supportedHarnesses = capabilities.supportedHarnesses

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建云电脑</DialogTitle>
          <DialogDescription>
            云电脑创建后立即启动，使用所选 Harness 工具。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="cloud-host-name" className="mb-1 block text-sm font-medium">
              名称
            </label>
            <input
              id="cloud-host-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的 OpenCode 云电脑"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {nameError && (
              <p className="mt-1 text-xs text-destructive">{nameError}</p>
            )}
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium">Harness 工具</span>
            {supportedHarnesses.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可用的 Harness 工具</p>
            ) : (
              <div className="space-y-2 rounded-md border border-border p-3">
                {supportedHarnesses.map((harness) => (
                  <label key={harness} className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedHarnesses.includes(harness)}
                      onChange={(event) => toggleHarness(harness, event.target.checked)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm text-foreground">{harnessLabel(harness)}</span>
                  </label>
                ))}
              </div>
            )}
            {harnessError && supportedHarnesses.length > 0 && (
              <p className="mt-1 text-xs text-destructive">{harnessError}</p>
            )}
            {selectedHarnesses.length === 1 && (
              <p className="mt-1 text-xs text-muted-foreground">将自动创建会话</p>
            )}
            {selectedHarnesses.length > 1 && (
              <p className="mt-1 text-xs text-muted-foreground">不自动创建会话</p>
            )}
          </div>

          {featureDisabled && (
            <p className="text-sm text-destructive">云电脑功能未开启</p>
          )}
          {hasActiveCloudHost && (
            <p className="text-sm text-destructive">每用户同时最多 1 个云电脑实例</p>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {submitting ? '创建中...' : '创建云电脑'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
