import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { CREATE_CLOUD_HOST } from '../../graphql/mutations'
import { CLOUD_HOST_BILLING_QUOTE, CLOUD_HOST_WORKLOAD_CATALOG } from '../../graphql/queries'
import type {
  CloudHostBillingQuoteQuery,
  CloudHostCapabilitiesData,
  CloudHostData,
  CloudHostWorkloadCatalogQuery,
  CloudHostWorkloadItemData,
  CreateCloudHostMutation,
  HarnessType,
} from '../../graphql/types'
import { useGithubProjectForm } from '../../hooks/useGithubProjectForm'
import { useCloudHostProvisioning } from '../../hooks/useCloudHostProvisioning'
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

interface NewCloudHostDialogProps {
  open: boolean
  capabilities: CloudHostCapabilitiesData
  onClose: () => void
  onCreated: (cloudHost: CloudHostData) => void
}

const HARNESS_LABELS: Record<string, string> = {
  OPENCODE: 'OpenCode',
  KIMI_CODE: 'Kimi Code',
  DEEPSEEK_HARNESS: 'DeepSeek Harness',
}

const NAME_MAX_LENGTH = 64
/** 创建时显式勾选的 standard 负载上限（契约：去重后 ≤5） */
const MAX_CREATE_WORKLOADS = 5

function harnessLabel(harness: HarnessType): string {
  return HARNESS_LABELS[harness] ?? harness
}

/** 服务端契约错误 → 前台中文文案；未登记的契约错误仍原样展示 */
const SERVER_ERROR_MESSAGES: Record<string, string> = {
  'insufficient balance': '账户余额不足，请联系管理员充值后重试',
  'github account is locked': '云电脑已绑定其他 Github 帐号，不可修改',
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
  onClose,
  onCreated,
}: NewCloudHostDialogProps) {
  const [name, setName] = useState('')
  const [selectedHarnesses, setSelectedHarnesses] = useState<HarnessType[]>([])
  const [selectedWorkloadIds, setSelectedWorkloadIds] = useState<string[]>([])
  const [projectEnabled, setProjectEnabled] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [createCloudHost] = useMutation<CreateCloudHostMutation>(CREATE_CLOUD_HOST)

  const provisioning = useCloudHostProvisioning()
  const projectForm = useGithubProjectForm({
    open,
    controllerId: '',
    // 云电脑尚未创建，没有 controllerId；Github 预制负载由服务端 setup 自动补齐
    includeWorkloads: false,
  })
  // 编排启动后只允许发起一次 setup（云电脑 RUNNING 回调可能重复触发）
  const setupStartedRef = useRef(false)
  const runningHostRef = useRef<CloudHostData | null>(null)

  const {
    data: catalogData,
    loading: catalogLoading,
    error: catalogError,
  } = useQuery<CloudHostWorkloadCatalogQuery>(CLOUD_HOST_WORKLOAD_CATALOG, {
    skip: !open,
    fetchPolicy: 'cache-and-network',
  })

  const {
    data: quoteData,
    loading: quoteLoading,
    error: quoteError,
    refetch: refetchQuote,
  } = useQuery<CloudHostBillingQuoteQuery>(CLOUD_HOST_BILLING_QUOTE, {
    skip: !open,
    fetchPolicy: 'cache-and-network',
  })
  const quote = quoteData?.cloudHostBillingQuote
  const balanceInsufficient =
    quote?.availableBalance !== null &&
    quote?.availableBalance !== undefined &&
    quote.availableBalance < quote.createCredits

  useEffect(() => {
    if (open) {
      setName('')
      setSelectedHarnesses([])
      setSelectedWorkloadIds([])
      setProjectEnabled(false)
      setSubmitting(false)
      setError(null)
      setupStartedRef.current = false
      provisioning.reset()
    }
    // 仅在打开/关闭时重置，避免编排状态变化导致表单被清空
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const projectIncomplete = projectEnabled && !projectForm.isValid
  const submitDisabled =
    submitting ||
    featureDisabled ||
    Boolean(nameError) ||
    Boolean(harnessError) ||
    projectIncomplete

  const handleCreateError = (err: unknown) => {
    setError(getErrorMessage(err));
    if (err instanceof Error && err.message.includes('insufficient balance')) {
      if (typeof refetchQuote === 'function') void refetchQuote();
    }
  };

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

  const handleHostRunning = async (host: CloudHostData) => {
    runningHostRef.current = host
    if (setupStartedRef.current) return
    if (!projectForm.normalizedPrefix) return
    setupStartedRef.current = true
    setSetupError(null)
    try {
      await provisioning.beginProjectSetup({
        controllerId: host.controllerId ?? '',
        harnessTypes: selectedHarnesses,
        project: {
          accountId: projectForm.accountId,
          repoFullName: projectForm.repoFullName,
          targetPath: projectForm.normalizedPrefix,
        },
      })
    } catch (err) {
      // 允许用户原地重试（云电脑仍可用）
      setupStartedRef.current = false
      setSetupError(getErrorMessage(err))
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitDisabled) return
    setSubmitting(true)
    setError(null)

    // 选了 Github 项目：createCloudHost(createDefaultSession=false) → 等 RUNNING → setup
    if (projectEnabled) {
      if (!projectForm.isValid || projectForm.normalizedPrefix === null) {
        setSubmitting(false)
        return
      }
      setupStartedRef.current = false
      try {
        await provisioning.start({
          name: trimmedName,
          harnessTypes: selectedHarnesses,
          githubAccountId: projectForm.accountId,
          ...(selectedWorkloadIds.length > 0 ? { workloadIds: selectedWorkloadIds } : {}),
          project: {
            accountId: projectForm.accountId,
            repoFullName: projectForm.repoFullName,
            targetPath: projectForm.normalizedPrefix,
          },
        })
      } catch (err) {
        handleCreateError(err)
      } finally {
        setSubmitting(false)
      }
      return
    }

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
      // 服务端错误文案原样展示（name is required / insufficient balance / ...）
      handleCreateError(err)
    } finally {
      setSubmitting(false)
    }
  }

  const supportedHarnesses = capabilities.supportedHarnesses

  // 编排中：同一对话框推进「启动云电脑 → 工作负载 → Git 项目 → 会话创建」
  if (provisioning.hostId) {
    return (
      <GithubSetupProgressDialog
        open={open}
        hostId={provisioning.hostId}
        operationId={provisioning.operationId}
        setupError={setupError}
        onRetrySetup={() => {
          const host = runningHostRef.current
          if (host) void handleHostRunning(host)
        }}
        onHostRunning={(host) => { void handleHostRunning(host) }}
        onStartupFailed={() => {
          setupStartedRef.current = false
          setSetupError(null)
          provisioning.reset()
        }}
        onClose={() => {
          provisioning.reset()
          onClose()
        }}
      />
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="min-w-0 max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md">
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
            {/* 默认工作区只在「Git 项目设置」初始化时创建：普通创建就绪后不会自动进会话 */}
            {selectedHarnesses.length === 1 && (
              <p className="mt-1 text-xs text-muted-foreground">
                就绪后不会自动创建会话，需先创建或绑定工作区
              </p>
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

          <div className="min-w-0 rounded-md border p-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                aria-label="配置 Github 项目"
                checked={projectEnabled}
                onChange={(event) => setProjectEnabled(event.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm font-medium">配置 Github 项目（可选）</span>
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              创建后自动安装 Github 工作负载、克隆仓库并进入项目会话
            </p>
            {projectEnabled && (
              <div className="mt-3 space-y-3">
                {!projectForm.hasAccounts ? (
                  <p className="text-sm text-muted-foreground">
                    尚未绑定 Github 帐号，请前往设置页绑定
                  </p>
                ) : (
                  <>
                    <div className="min-w-0">
                      <label htmlFor="cloud-host-github-account" className="mb-1 block text-sm font-medium">
                        Github 账号
                      </label>
                      <select
                        id="cloud-host-github-account"
                        aria-label="Github 账号"
                        value={projectForm.accountId}
                        onChange={(event) => projectForm.setAccountId(event.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        {projectForm.accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.githubLogin}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="min-w-0">
                      <label htmlFor="cloud-host-github-repo" className="mb-1 block text-sm font-medium">
                        仓库
                      </label>
                      {projectForm.repos.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          该账号暂无授权仓库，请前往设置页授权
                        </p>
                      ) : (
                        <select
                          id="cloud-host-github-repo"
                          aria-label="仓库"
                          value={projectForm.repoFullName}
                          onChange={(event) => projectForm.setRepoFullName(event.target.value)}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          <option value="">请选择仓库</option>
                          {projectForm.repos.map((repo) => (
                            <option key={repo.fullName} value={repo.fullName}>
                              {repo.fullName}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div className="min-w-0">
                      <label htmlFor="cloud-host-github-prefix" className="mb-1 block text-sm font-medium">
                        前缀地址（工作根目录）
                      </label>
                      <input
                        id="cloud-host-github-prefix"
                        type="text"
                        aria-label="前缀地址"
                        value={projectForm.targetPath}
                        onChange={(event) => projectForm.setTargetPath(event.target.value)}
                        placeholder="~/workspace"
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      {projectForm.prefixError !== null && (
                        <p className="mt-1 text-xs text-destructive">{projectForm.prefixError}</p>
                      )}
                      {projectForm.normalizedPrefix !== null && (
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          最终 clone 地址：{projectForm.finalClonePath ?? '—'}
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="min-w-0 rounded-md border p-3">
            <span className="mb-1 block text-sm font-medium">收费详情</span>
            {quoteError && !quote ? (
              <p className="text-xs text-muted-foreground">创建与运行将产生费用，详见账单</p>
            ) : quoteLoading && !quote ? (
              <p className="text-xs text-muted-foreground">正在加载报价...</p>
            ) : quote ? (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>创建花费：{quote.createCredits} credits（一次性，确认创建即扣费）</p>
                <p>
                  运行消费：{quote.perMinuteCredits} credit/分钟（自云电脑就绪起按分钟计费，不足
                  1 分钟按 1 分钟计）
                </p>
                <p>余额不足持续 10 分钟云电脑将被强制销毁</p>
                {balanceInsufficient && (
                  <p className="text-destructive">
                    当前可用余额：{quote.availableBalance} credits，余额不足，请联系管理员充值
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">创建与运行将产生费用，详见账单</p>
            )}
          </div>

          {featureDisabled && (
            <p className="text-sm text-destructive">云电脑功能未开启</p>
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
