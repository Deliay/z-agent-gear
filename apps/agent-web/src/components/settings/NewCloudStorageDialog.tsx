import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { CLOUD_STORAGE_BILLING_QUOTE } from '@/graphql/queries'
import { CREATE_CLOUD_STORAGE } from '@/graphql/mutations'
import type {
  CloudStorageBillingQuoteQuery,
  CloudStorageData,
  CreateCloudStorageMutation,
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
import { Label } from '@/components/ui/label'

interface NewCloudStorageDialogProps {
  open: boolean
  onClose: () => void
  /** 创建成功后回调（用于「新建…」自动选中） */
  onCreated?: (storage: CloudStorageData) => void
}

const NAME_MAX_LENGTH = 64
const MIN_SIZE_GI = 1
const MAX_SIZE_GI = 30
const DEFAULT_SIZE_GI = 10
const QUOTE_DEBOUNCE_MS = 300

/** 服务端契约错误 → 前台中文文案；未登记的契约错误仍原样展示 */
const SERVER_ERROR_MESSAGES: Record<string, string> = {
  'storage name is required': '请输入云存储名称',
  'storage name is too long': `名称不能超过 ${NAME_MAX_LENGTH} 个字符`,
  'storage name already exists': '当前工作区已存在同名云存储',
  'storage size must be between 1 and 30 Gi': '容量必须在 1~30Gi 之间',
  'insufficient balance': '账户余额不足，请联系管理员充值后重试',
  'global workspace is read-only': '全局工作区为只读，无法创建云存储',
  'storage feature is disabled': '云存储功能未开启',
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim()
    return SERVER_ERROR_MESSAGES[message] ?? message
  }
  return '创建云存储失败，请稍后重试'
}

/**
 * 新建云存储对话框：名称（trim 1~64）+ 容量（1~30Gi，默认 10）。
 * 容量变化后 300ms 防抖请求阶梯报价，展示全价 / 归档半价 / 分档明细。
 */
export default function NewCloudStorageDialog({
  open,
  onClose,
  onCreated,
}: NewCloudStorageDialogProps) {
  const [name, setName] = useState('')
  const [sizeText, setSizeText] = useState(String(DEFAULT_SIZE_GI))
  const [quoteSizeGi, setQuoteSizeGi] = useState(DEFAULT_SIZE_GI)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createCloudStorage] = useMutation<CreateCloudStorageMutation>(CREATE_CLOUD_STORAGE)

  useEffect(() => {
    if (!open) return
    setName('')
    setSizeText(String(DEFAULT_SIZE_GI))
    setQuoteSizeGi(DEFAULT_SIZE_GI)
    setSubmitting(false)
    setError(null)
  }, [open])

  // 容量输入防抖：300ms 后才更新报价请求参数
  useEffect(() => {
    const parsed = Number(sizeText)
    const timer = setTimeout(() => {
      if (Number.isInteger(parsed) && parsed >= MIN_SIZE_GI && parsed <= MAX_SIZE_GI) {
        setQuoteSizeGi(parsed)
      }
    }, QUOTE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [sizeText])

  const { data: quoteData, loading: quoteLoading, error: quoteError } =
    useQuery<CloudStorageBillingQuoteQuery>(CLOUD_STORAGE_BILLING_QUOTE, {
      variables: { sizeGi: quoteSizeGi },
      skip: !open,
      fetchPolicy: 'cache-and-network',
    })
  const quote = quoteData?.cloudStorageBillingQuote

  const trimmedName = name.trim()
  const sizeGi = Number(sizeText)
  const nameError =
    trimmedName.length === 0
      ? '请输入云存储名称'
      : trimmedName.length > NAME_MAX_LENGTH
        ? `名称不能超过 ${NAME_MAX_LENGTH} 个字符`
        : null
  const sizeError =
    !Number.isInteger(sizeGi) || sizeGi < MIN_SIZE_GI || sizeGi > MAX_SIZE_GI
      ? '容量必须在 1~30Gi 之间'
      : null
  const submitDisabled = submitting || Boolean(nameError) || Boolean(sizeError)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitDisabled) return
    setSubmitting(true)
    setError(null)
    try {
      const { data } = await createCloudStorage({
        variables: { input: { name: trimmedName, sizeGi } },
      })
      const created = data?.createCloudStorage
      if (!created) {
        setError('创建云存储失败，请稍后重试')
        return
      }
      toast.success('云存储创建成功')
      onCreated?.(created)
      onClose()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="min-w-0 max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建云存储</DialogTitle>
          <DialogDescription>
            云存储归属当前工作区，创建成功即开始按小时计费。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
          <div className="min-w-0">
            <Label htmlFor="cloud-storage-name">名称</Label>
            <Input
              id="cloud-storage-name"
              className="mt-1"
              value={name}
              maxLength={NAME_MAX_LENGTH}
              placeholder="例如：我的工作数据"
              onChange={(event) => setName(event.target.value)}
            />
            {nameError && <p className="mt-1 text-xs text-destructive">{nameError}</p>}
          </div>

          <div className="min-w-0">
            <Label htmlFor="cloud-storage-size">容量（Gi）</Label>
            <Input
              id="cloud-storage-size"
              className="mt-1"
              type="number"
              min={MIN_SIZE_GI}
              max={MAX_SIZE_GI}
              step={1}
              value={sizeText}
              onChange={(event) => setSizeText(event.target.value)}
            />
            {sizeError && <p className="mt-1 text-xs text-destructive">{sizeError}</p>}
          </div>

          <div className="min-w-0 rounded-md border p-3" data-testid="cloud-storage-quote">
            <span className="mb-1 block text-sm font-medium">费用</span>
            {quoteError && !quote ? (
              <p className="text-xs text-muted-foreground">报价暂时不可用</p>
            ) : quoteLoading && !quote ? (
              <p className="text-xs text-muted-foreground">正在计算费用...</p>
            ) : quote ? (
              <div className="space-y-2 text-xs text-muted-foreground">
                <p className="text-sm text-foreground">
                  全价：{quote.full.hourlyCredits} credits/小时
                </p>
                <p>已归档半价：{quote.archived.hourlyCredits} credits/小时</p>
                <div className="space-y-1">
                  <p className="font-medium text-foreground">分档明细（全价）</p>
                  {quote.full.tiers.length === 0 ? (
                    <p>无分档明细</p>
                  ) : (
                    quote.full.tiers.map((tier, index) => (
                      <p key={`${tier.label}-${index}`} className="break-words">
                        {tier.label}：{tier.amountCredits} credits/小时
                      </p>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">费用按容量阶梯计算</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">创建成功即开始计费</p>
          </div>

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
              {submitting ? '创建中...' : '创建云存储'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
