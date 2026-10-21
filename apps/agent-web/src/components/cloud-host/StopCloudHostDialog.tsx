import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { CLOUD_HOST_STOP_IMPACT } from '../../graphql/queries'
import { STOP_CLOUD_HOST } from '../../graphql/mutations'
import type {
  CloudHostData,
  CloudHostStopImpactData,
  CloudHostStopImpactQuery,
  StopCloudHostMutation,
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

interface StopCloudHostDialogProps {
  open: boolean
  cloudHost: Pick<CloudHostData, 'id' | 'name'>
  onClose: () => void
  onStopped: (cloudHost: CloudHostData) => void
}

const LOSS_WARNING = '停止云主机会导致所有会话永久丢失，是否继续'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return '停止云电脑失败，请稍后重试'
}

/**
 * 停止云电脑：打开时查询停止影响。
 * - 有活动会话：展示逐字告警，确认后传 force=true；
 * - 无活动会话：不弹告警，直接 stopCloudHost(force=false)。
 */
export default function StopCloudHostDialog({
  open,
  cloudHost,
  onClose,
  onStopped,
}: StopCloudHostDialogProps) {
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoStopFailed, setAutoStopFailed] = useState(false)
  const autoStopRef = useRef(false)
  const [stopCloudHost] = useMutation<StopCloudHostMutation>(STOP_CLOUD_HOST)

  const { data, loading, error: impactError, refetch } = useQuery<CloudHostStopImpactQuery>(
    CLOUD_HOST_STOP_IMPACT,
    {
      variables: { id: cloudHost.id },
      skip: !open,
      fetchPolicy: 'network-only',
    },
  )

  const impact: CloudHostStopImpactData | undefined = data?.cloudHostStopImpact

  useEffect(() => {
    if (!open) {
      autoStopRef.current = false
      setStopping(false)
      setError(null)
      setAutoStopFailed(false)
    }
  }, [open])

  const handleStop = useCallback(async (force: boolean) => {
    setStopping(true)
    setError(null)
    try {
      const { data: result } = await stopCloudHost({
        variables: { id: cloudHost.id, force },
      })
      const stopped = result?.stopCloudHost
      if (!stopped) {
        // 契约返回空值：不能停留在「停止中」，回到可重试状态并刷新影响数据
        setError('停止云电脑失败，请重试')
        if (!force) {
          setAutoStopFailed(true)
          void refetch()
        }
        return
      }
      onStopped(stopped)
    } catch (err) {
      setError(getErrorMessage(err))
      // 自动停止在「impact 查询 → stop」之间出现了新会话：允许用户确认强制停止，
      // 并重新拉取 impact 以展示最新活动会话数。
      if (!force) {
        setAutoStopFailed(true)
        void refetch()
      }
    } finally {
      setStopping(false)
    }
  }, [cloudHost.id, onStopped, stopCloudHost, refetch])

  // 无活动会话：直接停止，不展示告警
  useEffect(() => {
    if (!open || loading || !impact) return
    if (impact.activeSessionCount > 0) return
    if (autoStopRef.current || autoStopFailed) return
    autoStopRef.current = true
    void handleStop(false)
  }, [open, loading, impact, handleStop, autoStopFailed])

  const hasActiveSessions = (impact?.activeSessionCount ?? 0) > 0
  const sessions = impact?.sessions ?? []

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>停止云电脑</DialogTitle>
          <DialogDescription>
            {cloudHost.name}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">正在检查活动会话...</p>
        ) : impactError ? (
          <div className="space-y-2">
            <p role="alert" className="break-words text-sm text-destructive">
              {getErrorMessage(impactError)}
            </p>
            <Button type="button" variant="outline" onClick={() => { void refetch() }}>
              重试
            </Button>
          </div>
        ) : hasActiveSessions ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-destructive">{LOSS_WARNING}</p>
            <p className="text-sm text-muted-foreground">
              当前有 {impact?.activeSessionCount} 个活动会话。
            </p>
            {sessions.length > 0 ? (
              <ul
                className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2"
                data-testid="cloud-host-stop-sessions"
              >
                {sessions.map((session) => (
                  <li key={session.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate" title={session.title}>
                      {session.title || '未命名会话'}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{session.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="cloud-host-stop-sessions-empty">
                暂无会话明细
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            正在停止云电脑...
          </p>
        )}

        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={stopping}>
            取消
          </Button>
          {hasActiveSessions && (
            <Button
              type="button"
              variant="destructive"
              disabled={stopping}
              onClick={() => { void handleStop(true) }}
            >
              {stopping ? '停止中...' : '继续停止'}
            </Button>
          )}
          {!hasActiveSessions && autoStopFailed && (
            <Button
              type="button"
              variant="destructive"
              disabled={stopping}
              onClick={() => { void handleStop(true) }}
            >
              {stopping ? '停止中...' : '继续停止'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
