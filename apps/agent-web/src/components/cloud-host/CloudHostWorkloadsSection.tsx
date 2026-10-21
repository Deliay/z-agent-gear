import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { CLOUD_HOST_WORKLOADS } from '../../graphql/queries'
import { INSTALL_CLOUD_HOST_WORKLOAD } from '../../graphql/mutations'
import type {
  CloudHostData,
  CloudHostSetupOperationData,
  CloudHostWorkloadItemData,
  CloudHostWorkloadParamFieldData,
  CloudHostWorkloadsQuery,
  InstallCloudHostWorkloadMutation,
} from '../../graphql/types'
import GithubSetupProgressDialog from './GithubSetupProgressDialog'
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

interface CloudHostWorkloadsSectionProps {
  controllerId: string
  cloudHost: Pick<CloudHostData, 'id' | 'name' | 'status' | 'deletedAt' | 'workloadInstalling'>
  onChanged?: () => void
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return '安装工作负载失败，请稍后重试'
}

function defaultValueFor(field: CloudHostWorkloadParamFieldData): unknown {
  if (field.defaultValue !== undefined && field.defaultValue !== null) {
    return field.defaultValue
  }
  switch (field.type) {
    case 'BOOLEAN':
      return false
    case 'MULTI_SELECT':
      return []
    default:
      return ''
  }
}

function buildDefaultParams(schema: CloudHostWorkloadParamFieldData[]): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const field of schema) {
    params[field.key] = defaultValueFor(field)
  }
  return params
}

function WorkloadParamFields({
  schema,
  values,
  onChange,
}: {
  schema: CloudHostWorkloadParamFieldData[]
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}) {
  if (schema.length === 0) {
    return <p className="text-sm text-muted-foreground">该工作负载无需参数</p>
  }

  return (
    <div className="min-w-0 space-y-3">
      {schema.map((field) => {
        const value = values[field.key]
        if (field.type === 'BOOLEAN') {
          return (
            <label key={field.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={field.label}
                checked={Boolean(value)}
                onChange={(event) => onChange(field.key, event.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm">{field.label}</span>
            </label>
          )
        }

        if (field.type === 'SELECT') {
          return (
            <div key={field.key} className="min-w-0">
              <label htmlFor={`workload-param-${field.key}`} className="mb-1 block text-sm font-medium">
                {field.label}
              </label>
              <select
                id={`workload-param-${field.key}`}
                aria-label={field.label}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => onChange(field.key, event.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">请选择</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          )
        }

        if (field.type === 'MULTI_SELECT') {
          const selected = Array.isArray(value) ? value.map(String) : []
          return (
            <fieldset key={field.key} className="min-w-0">
              <legend className="mb-1 block text-sm font-medium">{field.label}</legend>
              <div className="space-y-2 rounded-md border border-border p-3">
                {(field.options ?? []).map((option) => (
                  <label key={option} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`${field.label} ${option}`}
                      checked={selected.includes(option)}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...selected.filter((item) => item !== option), option]
                          : selected.filter((item) => item !== option)
                        onChange(field.key, next)
                      }}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">{option}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )
        }

        return (
          <div key={field.key} className="min-w-0">
            <label htmlFor={`workload-param-${field.key}`} className="mb-1 block text-sm font-medium">
              {field.label}
            </label>
            <input
              id={`workload-param-${field.key}`}
              type="text"
              aria-label={field.label}
              value={typeof value === 'string' ? value : String(value ?? '')}
              onChange={(event) => onChange(field.key, event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        )
      })}
    </div>
  )
}

/**
 * 云电脑工作负载设置区：标准负载列表 + 参数表单 + 安装进度。
 * 已安装项仅展示徽标并禁用安装；产品口径不提供卸载入口。
 */
export default function CloudHostWorkloadsSection({
  controllerId,
  cloudHost,
  onChanged,
}: CloudHostWorkloadsSectionProps) {
  const { data, loading, refetch } = useQuery<CloudHostWorkloadsQuery>(CLOUD_HOST_WORKLOADS, {
    variables: { controllerId },
  })
  const [installWorkload] = useMutation<InstallCloudHostWorkloadMutation>(INSTALL_CLOUD_HOST_WORKLOAD)

  const [installTarget, setInstallTarget] = useState<CloudHostWorkloadItemData | null>(null)
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [operation, setOperation] = useState<CloudHostSetupOperationData | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const workloads = data?.cloudHostWorkloads ?? []
  const hostRunning = cloudHost.status === 'RUNNING' && !cloudHost.deletedAt
  const installingName = cloudHost.workloadInstalling ?? null

  const targetSchema = useMemo(() => installTarget?.paramSchema ?? [], [installTarget])

  const openInstallDialog = (workload: CloudHostWorkloadItemData) => {
    setInstallTarget(workload)
    setParams(buildDefaultParams(workload.paramSchema ?? []))
    setError(null)
  }

  const closeInstallDialog = () => {
    if (submitting) return
    setInstallTarget(null)
    setError(null)
  }

  const handleParamChange = (key: string, value: unknown) => {
    setParams((prev) => ({ ...prev, [key]: value }))
  }

  const handleInstall = async () => {
    if (!installTarget || !hostRunning) return
    setSubmitting(true)
    setError(null)
    try {
      const { data: result } = await installWorkload({
        variables: {
          input: {
            controllerId,
            workloadId: installTarget.workloadId,
            params,
          },
        },
      })
      if (result?.installCloudHostWorkload) {
        setOperation(result.installCloudHostWorkload)
        setInstallTarget(null)
      }
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleFinished = () => {
    void refetch()
    onChanged?.()
  }

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="text-lg font-medium">工作负载</h2>
        {installingName && (
          <span className="truncate text-xs text-muted-foreground" data-testid="workload-installing">
            安装中：{installingName}
          </span>
        )}
      </div>

      {!hostRunning && (
        <p className="text-sm text-muted-foreground">等待云电脑运行中</p>
      )}

      {loading && !data ? (
        <p className="text-sm text-muted-foreground">正在加载工作负载...</p>
      ) : workloads.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无可安装工作负载</p>
      ) : (
        <ul className="min-w-0 space-y-2">
          {workloads.map((workload) => (
            <li
              key={workload.workloadId}
              className="min-w-0 rounded-lg border border-border p-3"
              data-testid={`workload-item-${workload.workloadId}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-words text-sm font-medium">{workload.name}</span>
                {workload.isPreset && (
                  <Badge variant="outline" className="shrink-0">
                    预制
                  </Badge>
                )}
                {workload.installed && (
                  <Badge variant="secondary" className="shrink-0">
                    已安装
                  </Badge>
                )}
                <span className="ml-auto shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`安装 ${workload.name}`}
                    disabled={workload.installed || !hostRunning}
                    onClick={() => openInstallDialog(workload)}
                  >
                    安装
                  </Button>
                </span>
              </div>
              {workload.paramSchema.length > 0 && (
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  参数：{workload.paramSchema.map((field) => field.label || field.key).join('、')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={installTarget !== null} onOpenChange={(next) => { if (!next) closeInstallDialog() }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>安装工作负载</DialogTitle>
            <DialogDescription>
              {installTarget?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-3">
            <WorkloadParamFields schema={targetSchema} values={params} onChange={handleParamChange} />
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeInstallDialog} disabled={submitting}>
              取消
            </Button>
            <Button type="button" onClick={() => { void handleInstall() }} disabled={submitting || !hostRunning}>
              {submitting ? '安装中...' : '开始安装'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {operation && (
        <GithubSetupProgressDialog
          open={operation !== null}
          operationId={operation.id}
          onClose={() => setOperation(null)}
          onFinished={handleFinished}
        />
      )}
    </section>
  )
}
