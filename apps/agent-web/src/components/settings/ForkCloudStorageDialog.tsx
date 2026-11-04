import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { CLOUD_STORAGE_BILLING_QUOTE } from '@/graphql/queries'
import { FORK_CLOUD_STORAGE } from '@/graphql/mutations'
import type {
  CloudStorageBillingQuoteQuery,
  CloudStorageData,
  ForkCloudStorageMutation,
} from '@/graphql/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ForkCloudStorageDialogProps {
  open: boolean
  source: CloudStorageData | null
  onClose: () => void
  onForked: (storage: CloudStorageData) => void
}

const NAME_MAX = 64

const SERVER_ERROR_MESSAGES: Record<string, string> = {
  'storage name is required': '请输入名称',
  'storage name is too long': '名称最多 64 个字符',
  'storage name already exists': '当前工作区已存在同名云存储',
  'storage is not forkable': '源存储没有可用归档，暂不可 fork',
  'storage is restoring': '有正在进行的复原操作，请稍后重试',
  'insufficient balance': '账户余额不足，请联系管理员充值后重试',
  'global workspace is read-only': '全局工作区为只读，无法创建云存储',
  'storage feature is disabled': '云存储功能未启用',
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim()
    return SERVER_ERROR_MESSAGES[message] ?? message
  }
  return 'fork 失败，请稍后重试'
}

/**
 * fork 云存储：名称自定 + 容量与源一致（只读）+ 全价报价；创建成功即开始计费。
 * 服务端为名称唯一/源归档状态/余额的权威判定。
 */
export default function ForkCloudStorageDialog({
  open,
  source,
  onClose,
  onForked,
}: ForkCloudStorageDialogProps) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: quoteData } = useQuery<CloudStorageBillingQuoteQuery>(
    CLOUD_STORAGE_BILLING_QUOTE,
    {
      variables: { sizeGi: source?.sizeGi },
      skip: !open || !source,
      fetchPolicy: 'cache-and-network',
    },
  )
  const [forkStorage] = useMutation<ForkCloudStorageMutation>(FORK_CLOUD_STORAGE)

  useEffect(() => {
    if (!open) return
    setName('')
    setSubmitting(false)
    setError(null)
  }, [open, source?.id])

  const trimmed = name.trim()
  const nameValid = trimmed.length >= 1 && trimmed.length <= NAME_MAX
  const quote = quoteData?.cloudStorageBillingQuote

  const handleSubmit = async () => {
    if (!source || submitting) return
    if (!nameValid) {
      setError(trimmed ? `名称最多 ${NAME_MAX} 个字符` : '请输入名称')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const { data } = await forkStorage({
        variables: { id: source.id, input: { name: trimmed } },
      })
      const created = data?.forkCloudStorage
      if (!created) {
        setError('fork 失败，请稍后重试')
        return
      }
      toast.success('已创建 fork 云存储')
      onForked(created)
      onClose()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>fork 云存储</DialogTitle>
          <DialogDescription>
            从「{source?.name ?? '云存储'}」的当前归档复制一块新云存储
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          <div className="space-y-1">
            <label htmlFor="fork-storage-name" className="text-sm font-medium">
              名称
            </label>
            <Input
              id="fork-storage-name"
              aria-label="fork 云存储名称"
              value={name}
              maxLength={NAME_MAX}
              disabled={submitting}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：my-data-copy"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            容量与源一致：{source?.sizeGi ?? 0}Gi（不可调整）
          </p>
          <p className="text-sm text-muted-foreground">
            {quote
              ? `每小时费用：${quote.full.hourlyCredits} credits（创建成功即开始计费）`
              : '创建成功即开始计费，详见账单'}
          </p>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            type="button"
            disabled={!source || submitting || !nameValid}
            onClick={() => { void handleSubmit() }}
          >
            {submitting ? '创建中...' : '确认 fork'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
