import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { CLOUD_HOST_SETUP_OPERATION } from '../../graphql/queries'
import { RETRY_CLOUD_HOST_SETUP_OPERATION } from '../../graphql/mutations'
import type {
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
  /** 终态（成功/失败）回调；用于列表刷新等附带动作 */
  onFinished?: (operation: CloudHostSetupOperationData) => void
}

const STEP_LABELS: Record<string, string> = {
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

/**
 * Git 项目设置 / 工作负载安装的进度对话框。
 *
 * 每 1.5s 轮询 operation；加载分支只认 `loading && !data`，轮询期间不卸载内容。
 * 前端只展示步骤状态与后端给出的可读 detail/error，不展示 token 或脚本命令。
 */
export default function GithubSetupProgressDialog({
  open,
  operationId,
  onClose,
  onFinished,
}: GithubSetupProgressDialogProps) {
  const navigate = useNavigate()
  const { refetch: refetchHome } = useHomeOverview()
  const [retryOperation, { loading: retrying }] = useMutation<RetryCloudHostSetupOperationMutation>(
    RETRY_CLOUD_HOST_SETUP_OPERATION,
  )
  const [retryError, setRetryError] = useState<string | null>(null)
  const navigatedRef = useRef(false)
  const finishedRef = useRef(false)

  const { data, loading, error, refetch } = useQuery<CloudHostSetupOperationQuery>(
    CLOUD_HOST_SETUP_OPERATION,
    {
      variables: { id: operationId ?? '' },
      skip: !open || !operationId,
      pollInterval: 1500,
      fetchPolicy: 'cache-and-network',
    },
  )

  const operation = data?.cloudHostSetupOperation ?? null

  useEffect(() => {
    if (!open) {
      navigatedRef.current = false
      finishedRef.current = false
      setRetryError(null)
    }
  }, [open])

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
    void Promise.resolve(refetchHome()).finally(() => {
      navigate(`/sessions/${operation.sessionId}`)
      onClose()
    })
  }, [open, operation, navigate, onClose, refetchHome])

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
  const stepKeys =
    operation?.kind === 'INSTALL_WORKLOAD'
      ? ['workload']
      : [...GITHUB_STEP_KEYS]
  const stepByKey = new Map<string, CloudHostSetupStepData>(
    (operation?.steps ?? []).map((step) => [step.key, step]),
  )

  const terminal = operation?.status === 'SUCCEEDED' || operation?.status === 'FAILED'

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>设置进度</DialogTitle>
          <DialogDescription>
            {operation?.kind === 'INSTALL_WORKLOAD' ? '正在安装工作负载...' : '正在配置仓库与会话...'}
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
        ) : !operation ? (
          <p className="text-sm text-muted-foreground">未找到操作记录</p>
        ) : (
          <div className="min-w-0 space-y-3">
            <ol className="min-w-0 space-y-3" data-testid="github-setup-steps">
              {stepKeys.map((key) => {
                const step = stepByKey.get(key) ?? { key, status: 'PENDING' as const, detail: null }
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

            {operation.error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {operation.error}
              </p>
            )}

            {retryError && (
              <p role="alert" className="break-words text-sm text-destructive">
                {retryError}
              </p>
            )}

            {operation.status === 'SUCCEEDED' && sessionFailed && (
              <p className="break-words text-sm text-warning">
                仓库已就绪，请手动创建会话
              </p>
            )}

            {operation.status === 'SUCCEEDED' && !operation.sessionId && !sessionFailed && (
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
          {operation?.status === 'FAILED' && (
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
