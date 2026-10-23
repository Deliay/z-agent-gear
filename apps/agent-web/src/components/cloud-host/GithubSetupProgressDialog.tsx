import { useEffect, useRef, useState } from 'react'
import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { CLOUD_HOST, CLOUD_HOST_SETUP_OPERATION, GET_CONTROLLER_WORKSPACES_ENABLED } from '../../graphql/queries'
import { RETRY_CLOUD_HOST_SETUP_OPERATION } from '../../graphql/mutations'
import type {
  CloudHostData,
  CloudHostQuery,
  CloudHostSetupOperationData,
  CloudHostSetupOperationQuery,
  CloudHostSetupStepData,
  CloudHostSetupStepStatus,
  RetryCloudHostSetupOperationMutation,
} from '../../graphql/types'
import { useHomeOverview } from '../../stores/homeOverview'
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

interface GithubSetupProgressDialogProps {
  open: boolean
  operationId: string | null
  onClose: () => void
  /**
   * 可选前置阶段「启动云电脑」：新建云电脑 + Git 项目编排时传入，
   * 由本对话框以 1.5s 轮询 `cloudHost(id)` 驱动；旧入口不传，保持三阶段。
   */
  hostId?: string
  /** 云电脑启动成功（RUNNING）时回调一次，供调用方发起项目准备 */
  onHostRunning?: (host: CloudHostData) => void
  /** 启动失败时点击「重新创建」的回调 */
  onStartupFailed?: () => void
  /** 项目准备请求本身失败（尚未生成 operation）时的错误文案 */
  setupError?: string | null
  /** 项目准备请求失败后的原地重试 */
  onRetrySetup?: () => void
  /** 终态（成功/失败）回调；用于列表刷新等附带动作 */
  onFinished?: (operation: CloudHostSetupOperationData) => void
}

const STEP_LABELS: Record<string, string> = {
  startup: '启动云电脑',
  workload: '工作负载设置',
  gitSetup: 'Git 项目设置',
  session: '会话创建',
}

const GITHUB_STEP_KEYS = ['workload', 'gitSetup', 'session'] as const

const STEP_STATUS_LABELS: Record<CloudHostSetupStepStatus, string> = {
  PENDING: '等待',
  RUNNING: '进行中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  SKIPPED: '跳过',
}

const STEP_STATUS_CLASSES: Record<CloudHostSetupStepStatus, string> = {
  PENDING: 'border-transparent bg-muted text-muted-foreground',
  RUNNING: 'border-transparent bg-warning/10 text-warning',
  SUCCEEDED: 'border-transparent bg-success/10 text-success',
  FAILED: 'border-transparent bg-destructive/10 text-destructive',
  SKIPPED: 'border-transparent bg-muted text-muted-foreground',
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return '重试失败，请稍后重试'
}

/** 云电脑状态 → 「启动云电脑」阶段展示 */
function startupStepFromHost(host: CloudHostData): {
  status: CloudHostSetupStepStatus
  detail: string | null
} {
  if (host.deletedAt) return { status: 'FAILED', detail: '云电脑已删除' }
  switch (host.status) {
    case 'RUNNING':
      return { status: 'SUCCEEDED', detail: null }
    case 'FAILED':
      return { status: 'FAILED', detail: host.failureReason ?? '云电脑启动失败' }
    case 'STOPPING':
      return { status: 'FAILED', detail: '云电脑正在停止' }
    case 'STOPPED':
      return { status: 'FAILED', detail: '云电脑已停止' }
    default:
      return { status: 'RUNNING', detail: null }
  }
}

/**
 * Git 项目设置 / 工作负载安装 / 新建云电脑编排的进度对话框。
 *
 * 每 1.5s 轮询 operation；加载分支只认 `loading && !data`，轮询期间不卸载内容。
 * 传入 `hostId` 时额外展示「启动云电脑」前置阶段（同样 1.5s 轮询），旧入口保持三阶段。
 * 前端只展示步骤状态与后端给出的可读 detail/error，不展示 token 或脚本命令。
 */
export default function GithubSetupProgressDialog({
  open,
  operationId,
  onClose,
  hostId,
  onHostRunning,
  onStartupFailed,
  setupError,
  onRetrySetup,
  onFinished,
}: GithubSetupProgressDialogProps) {
  const navigate = useNavigate()
  const client = useApolloClient()
  const { refetch: refetchHome } = useHomeOverview()
  const [retryOperation, { loading: retrying }] = useMutation<RetryCloudHostSetupOperationMutation>(
    RETRY_CLOUD_HOST_SETUP_OPERATION,
  )
  const [retryError, setRetryError] = useState<string | null>(null)
  const navigatedRef = useRef(false)
  const finishedRef = useRef(false)
  const hostRunningRef = useRef<string | null>(null)

  const { data, loading, error, refetch } = useQuery<CloudHostSetupOperationQuery>(
    CLOUD_HOST_SETUP_OPERATION,
    {
      variables: { id: operationId ?? '' },
      skip: !open || !operationId,
      pollInterval: 1500,
      fetchPolicy: 'cache-and-network',
    },
  )

  const { data: hostData } = useQuery<CloudHostQuery>(CLOUD_HOST, {
    variables: { id: hostId ?? '' },
    skip: !open || !hostId,
    pollInterval: 1500,
    fetchPolicy: 'cache-and-network',
  })

  const operation = data?.cloudHostSetupOperation ?? null
  const host = hostData?.cloudHost ?? null

  useEffect(() => {
    if (!open) {
      navigatedRef.current = false
      finishedRef.current = false
      hostRunningRef.current = null
      setRetryError(null)
    }
  }, [open])

  // 云电脑启动成功：每个 hostId 只通知调用方一次（避免轮询重复触发 setup）
  useEffect(() => {
    if (!open || !hostId || !host) return
    if (host.status !== 'RUNNING' || host.deletedAt) return
    if (hostRunningRef.current === hostId) return
    hostRunningRef.current = hostId
    onHostRunning?.(host)
  }, [open, hostId, host, onHostRunning])

  useEffect(() => {
    if (!open || !operation) return
    if (operation.status === 'RUNNING') {
      finishedRef.current = false
      return
    }
    if (!finishedRef.current) {
      finishedRef.current = true
      onFinished?.(operation)
    }
  }, [open, operation, onFinished])

  useEffect(() => {
    if (!open || !operation) return
    if (operation.status !== 'SUCCEEDED' || !operation.sessionId) return
    if (navigatedRef.current) return
    navigatedRef.current = true
    // Git 项目设置成功后工作区列表新增条目：刷新首页与控制器工作区查询
    void Promise.resolve(client.refetchQueries({ include: [GET_CONTROLLER_WORKSPACES_ENABLED] }))
      .catch(() => undefined)
      .then(() => Promise.resolve(refetchHome()))
      .finally(() => {
        navigate(`/sessions/${operation.sessionId}`)
        onClose()
      })
  }, [open, operation, navigate, onClose, refetchHome, client])

  const handleRetry = async () => {
    if (!operation) return
    setRetryError(null)
    finishedRef.current = false
    try {
      await retryOperation({ variables: { id: operation.id } })
      await refetch()
    } catch (err) {
      setRetryError(getErrorMessage(err))
    }
  }

  const handleClose = () => {
    onClose()
  }

  const sessionStep = operation?.steps.find((step) => step.key === 'session')
  const sessionFailed = sessionStep?.status === 'FAILED'
  const stepKeys = hostId
    ? ['startup', ...GITHUB_STEP_KEYS]
    : operation?.kind === 'INSTALL_WORKLOAD'
      ? ['workload']
      : [...GITHUB_STEP_KEYS]
  const stepByKey = new Map<string, CloudHostSetupStepData>(
    (operation?.steps ?? []).map((step) => [step.key, step]),
  )

  const startupStep = hostId
    ? host
      ? startupStepFromHost(host)
      : { status: 'RUNNING' as CloudHostSetupStepStatus, detail: null }
    : null
  const startupFailed = startupStep?.status === 'FAILED'

  const terminal =
    startupFailed || operation?.status === 'SUCCEEDED' || operation?.status === 'FAILED'

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>设置进度</DialogTitle>
          <DialogDescription>
            {operation?.kind === 'INSTALL_WORKLOAD'
              ? '正在安装工作负载...'
              : hostId && !operationId
                ? '正在启动云电脑...'
                : '正在配置仓库与会话...'}
          </DialogDescription>
        </DialogHeader>

        {loading && !data ? (
          <p className="text-sm text-muted-foreground">正在加载进度...</p>
        ) : error ? (
          <div className="space-y-2">
            <p role="alert" className="break-words text-sm text-destructive">
              {getErrorMessage(error)}
            </p>
            <Button type="button" variant="outline" onClick={() => { void refetch() }}>
              重试
            </Button>
          </div>
        ) : !operation && !hostId ? (
          <p className="text-sm text-muted-foreground">未找到操作记录</p>
        ) : (
          <div className="min-w-0 space-y-3">
            <ol className="min-w-0 space-y-3" data-testid="github-setup-steps">
              {stepKeys.map((key) => {
                const step =
                  key === 'startup' && startupStep
                    ? { key, ...startupStep }
                    : stepByKey.get(key) ?? { key, status: 'PENDING' as const, detail: null }
                return (
                  <li key={key} className="flex min-w-0 items-start gap-2">
                    <Badge className={`shrink-0 ${STEP_STATUS_CLASSES[step.status]}`}>
                      {STEP_STATUS_LABELS[step.status]}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium">
                        {STEP_LABELS[key] ?? key}
                      </p>
                      {step.detail && (
                        <p className="break-words text-xs text-muted-foreground">
                          {step.detail}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>

            {operation?.error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {operation.error}
              </p>
            )}

            {retryError && (
              <p role="alert" className="break-words text-sm text-destructive">
                {retryError}
              </p>
            )}

            {setupError && (
              <div className="space-y-2">
                <p role="alert" className="break-words text-sm text-destructive">
                  {setupError}
                </p>
                {onRetrySetup && (
                  <Button type="button" variant="outline" size="sm" onClick={onRetrySetup}>
                    重新设置
                  </Button>
                )}
              </div>
            )}

            {startupFailed && (
              <p role="alert" className="break-words text-sm text-destructive">
                云电脑启动失败，请删除后重新创建
              </p>
            )}

            {operation?.status === 'SUCCEEDED' && sessionFailed && (
              <p className="break-words text-sm text-warning">
                仓库已就绪，请手动创建会话
              </p>
            )}

            {operation?.status === 'SUCCEEDED' && !operation.sessionId && !sessionFailed && (
              <p className="break-words text-sm text-success">操作已完成</p>
            )}
          </div>
        )}

        <DialogFooter>
          {terminal && (
            <Button type="button" variant="outline" onClick={handleClose} disabled={retrying}>
              关闭
            </Button>
          )}
          {startupFailed && onStartupFailed && (
            <Button
              type="button"
              onClick={() => {
                handleClose()
                onStartupFailed()
              }}
            >
              重新创建
            </Button>
          )}
          {operation?.status === 'FAILED' && !startupFailed && (
            <Button type="button" onClick={() => { void handleRetry() }} disabled={retrying}>
              {retrying ? '重试中...' : '重试'}
            </Button>
          )}
          {!terminal && (
            <Button type="button" variant="outline" onClick={handleClose}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
