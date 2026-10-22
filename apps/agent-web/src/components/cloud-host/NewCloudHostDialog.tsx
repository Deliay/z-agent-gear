import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { CREATE_CLOUD_HOST } from '../../graphql/mutations'
import { CLOUD_HOST_WORKLOAD_CATALOG } from '../../graphql/queries'
import type {
  CloudHostCapabilitiesData,
  CloudHostData,
  CloudHostWorkloadCatalogQuery,
  CloudHostWorkloadItemData,
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
import { Badge } from '@/components/ui/badge'

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
/** 创建时显式勾选的 standard 负载上限（契约：去重后 ≤5） */
const MAX_CREATE_WORKLOADS = 5

function harnessLabel(harness: HarnessType): string {
  return HARNESS_LABELS[harness] ?? harness
}

/** 服务端契约错误 → 前台中文文案；未登记的契约错误仍原样展示 */
const SERVER_ERROR_MESSAGES: Record<string, string> = {
  'too many cloud hosts': '每用户同时最多 1 个云电脑实例',
  'too many workloads (max 5)': '创建时最多选择 5 个工作负载',
  'workloads exceed 10': '展开依赖后超过工作负载上限（10 个）',
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim()
    if (SERVER_ERROR_MESSAGES[message]) return SERVER_ERROR_MESSAGES[message]
    // 先匹配更具体的 parameter 错误，避免被 invalid workload 前缀吞掉
    if (message.startsWith('invalid workload parameter')) return '工作负载参数默认值非法，无法创建'
    if (message.startsWith('invalid workload')) return '所选工作负载不存在或不可用'
    if (message.startsWith('workload is not installable')) return '该工作负载不支持创建时预装'
    if (message.startsWith('dependency workload not found')) return '工作负载依赖缺失，无法创建'
    if (message.startsWith('dependency cycle detected')) return '工作负载依赖成环，无法创建'
    return message
  }
  return '创建云电脑失败，请稍后重试'
}

/**
 * 新建云电脑对话框：名称（trim 1~64）+ harness 多选（≥1）+ 可选预装 standard 负载。
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
  const [selectedWorkloadIds, setSelectedWorkloadIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createCloudHost] = useMutation<CreateCloudHostMutation>(CREATE_CLOUD_HOST)

  const {
    data: catalogData,
    loading: catalogLoading,
    error: catalogError,
  } = useQuery<CloudHostWorkloadCatalogQuery>(CLOUD_HOST_WORKLOAD_CATALOG, {
    skip: !open,
    fetchPolicy: 'cache-and-network',
  })

  useEffect(() => {
    if (open) {
      setName('')
      setSelectedHarnesses([])
      setSelectedWorkloadIds([])
      setSubmitting(false)
      setError(null)
    }
  }, [open])

  const workloads = useMemo(
    () => catalogData?.cloudHostWorkloadCatalog ?? [],
    [catalogData],
  )
  const workloadNames = useMemo(
    () => new Map(workloads.map((workload) => [workload.workloadId, workload.name])),
    [workloads],
  )

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

  const toggleWorkload = (workloadId: string, checked: boolean) => {
    setSelectedWorkloadIds((prev) => {
      if (checked) {
        if (prev.includes(workloadId) || prev.length >= MAX_CREATE_WORKLOADS) return prev
        return [...prev, workloadId]
      }
      return prev.filter((id) => id !== workloadId)
    })
  }

  const dependencyNames = (workload: CloudHostWorkloadItemData): string[] =>
    (workload.dependsOnWorkloadIds ?? []).map((id) => workloadNames.get(id) ?? id)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitDisabled) return

    setSubmitting(true)
    setError(null)
    try {
      const { data } = await createCloudHost({
        variables: {
          input: {
            name: trimmedName,
            harnessTypes: selectedHarnesses,
            // 未勾选时不传 workloadIds，保持旧报文形状
            ...(selectedWorkloadIds.length > 0 ? { workloadIds: selectedWorkloadIds } : {}),
          },
        },
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
      <DialogContent className="min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建云电脑</DialogTitle>
          <DialogDescription>
            云电脑创建后立即启动，使用所选 Harness 工具。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
          <div className="min-w-0">
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

          <div className="min-w-0">
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

          <div className="min-w-0">
            <span className="mb-1 block text-sm font-medium">预装工作负载（可选）</span>
            {catalogError ? (
              <p className="text-xs text-muted-foreground">负载列表加载失败，可仅创建基础云电脑</p>
            ) : catalogLoading && !catalogData ? (
              <p className="text-sm text-muted-foreground">正在加载工作负载...</p>
            ) : workloads.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可预装工作负载</p>
            ) : (
              <div className="space-y-2 rounded-md border border-border p-3">
                {workloads.map((workload) => {
                  const deps = dependencyNames(workload)
                  return (
                    <label key={workload.workloadId} className="flex min-w-0 items-start gap-2">
                      <input
                        type="checkbox"
                        aria-label={workload.name}
                        checked={selectedWorkloadIds.includes(workload.workloadId)}
                        onChange={(event) => toggleWorkload(workload.workloadId, event.target.checked)}
                        className="mt-0.5 h-4 w-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm text-foreground">{workload.name}</span>
                          {workload.isPreset && (
                            <Badge variant="outline" className="shrink-0">
                              预制
                            </Badge>
                          )}
                        </span>
                        {deps.length > 0 && (
                          <span className="mt-0.5 block break-words text-xs text-muted-foreground">
                            依赖：{deps.join('、')}
                          </span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            {selectedWorkloadIds.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                勾选运行环境负载会延长首次就绪时间
              </p>
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
