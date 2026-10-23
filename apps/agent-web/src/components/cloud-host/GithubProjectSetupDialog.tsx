import { useEffect, useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { SETUP_CLOUD_HOST_GITHUB_PROJECT } from '../../graphql/mutations'
import type {
  CloudHostData,
  SetupCloudHostGithubProjectMutation,
} from '../../graphql/types'
import GithubSetupProgressDialog from './GithubSetupProgressDialog'
import { useGithubProjectForm } from '../../hooks/useGithubProjectForm'
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

interface GithubProjectSetupDialogProps {
  open: boolean
  controllerId: string
  cloudHost: Pick<CloudHostData, 'id' | 'name' | 'status' | 'deletedAt' | 'defaultWorkspace'>
  onClose: () => void
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Git 项目设置失败，请稍后重试'
}

/**
 * 云电脑 Git 项目设置：Github 账号 → 仓库 → 工作负载 → 目标路径。
 * 目标主机固定为当前云电脑；确认后创建 operation 并进入分步进度对话框。
 */
export default function GithubProjectSetupDialog({
  open,
  controllerId,
  cloudHost,
  onClose,
}: GithubProjectSetupDialogProps) {
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)

  const form = useGithubProjectForm({
    open,
    controllerId,
    defaultWorkspace: cloudHost.defaultWorkspace,
  })
  const {
    accounts,
    accountsLoading,
    workloads,
    workloadsLoading,
    accountId,
    setAccountId,
    repoFullName,
    setRepoFullName,
    repos,
    targetPath,
    setTargetPath,
    selectedWorkloadIds,
    toggleWorkload,
    prefixError,
    normalizedPrefix,
    finalClonePath,
    hasAccounts,
  } = form

  const [setupGithubProject] = useMutation<SetupCloudHostGithubProjectMutation>(
    SETUP_CLOUD_HOST_GITHUB_PROJECT,
  )

  useEffect(() => {
    if (!open) return
    setSubmitting(false)
    setError(null)
    setOperationId(null)
  }, [open])

  const hostRunning = cloudHost.status === 'RUNNING' && !cloudHost.deletedAt
  const submitDisabled =
    submitting ||
    !hostRunning ||
    !form.isValid ||
    normalizedPrefix === null

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitDisabled || normalizedPrefix === null) return

    setSubmitting(true)
    setError(null)
    try {
      const { data } = await setupGithubProject({
        variables: {
          input: {
            controllerId,
            accountId,
            repoFullName,
            // 提交前缀（非最终目录），服务端负责拼接 <前缀>/<owner>/<repo>
            targetPath: normalizedPrefix,
            workloadIds: selectedWorkloadIds,
          },
        },
      })
      const operation = data?.setupCloudHostGithubProject
      if (operation) {
        setOperationId(operation.id)
      }
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (operationId) {
    return (
      <GithubSetupProgressDialog
        open={open}
        operationId={operationId}
        onClose={() => {
          setOperationId(null)
          onClose()
        }}
      />
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Git 项目设置</DialogTitle>
          <DialogDescription>
            选择 Github 账号与仓库，云电脑将自动克隆仓库并创建会话。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
          <div className="min-w-0">
            <span className="mb-1 block text-sm font-medium">目标主机</span>
            <p className="break-words rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
              {cloudHost.name}
            </p>
            {!hostRunning && (
              <p className="mt-1 text-xs text-destructive">云电脑未运行，无法设置 Git 项目</p>
            )}
          </div>

          {accountsLoading && !hasAccounts ? (
            <p className="text-sm text-muted-foreground">正在加载 Github 账号...</p>
          ) : !hasAccounts ? (
            <div className="space-y-2 rounded-md border border-dashed p-3">
              <p className="text-sm text-muted-foreground">尚未绑定 Github 帐号</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigate('/settings#github-section')}
              >
                前往设置页绑定 Github 帐号
              </Button>
            </div>
          ) : (
            <div className="min-w-0">
              <label htmlFor="github-setup-account" className="mb-1 block text-sm font-medium">
                Github 账号
              </label>
              <select
                id="github-setup-account"
                aria-label="Github 账号"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.githubLogin}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="min-w-0">
            <label htmlFor="github-setup-repo" className="mb-1 block text-sm font-medium">
              仓库
            </label>
            {repos.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {hasAccounts ? '该账号暂无授权仓库，请前往设置页授权' : '绑定账号后选择仓库'}
              </p>
            ) : (
              <select
                id="github-setup-repo"
                aria-label="仓库"
                value={repoFullName}
                onChange={(event) => setRepoFullName(event.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">请选择仓库</option>
                {repos.map((repo) => (
                  <option key={repo.fullName} value={repo.fullName}>
                    {repo.fullName}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="min-w-0">
            <span className="mb-1 block text-sm font-medium">工作负载</span>
            {workloadsLoading && workloads.length === 0 ? (
              <p className="text-sm text-muted-foreground">正在加载工作负载...</p>
            ) : workloads.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可选工作负载</p>
            ) : (
              <div className="space-y-2 rounded-md border border-border p-3">
                {workloads.map((workload) => {
                  const preset = Boolean(workload.isPreset) && workload.name === 'Github'
                  return (
                    <label key={workload.workloadId} className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={workload.name}
                        checked={selectedWorkloadIds.includes(workload.workloadId)}
                        disabled={preset}
                        onChange={(event) => toggleWorkload(workload.workloadId, event.target.checked)}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="truncate text-sm text-foreground">{workload.name}</span>
                      {workload.isPreset && (
                        <Badge variant="outline" className="shrink-0">
                          预制
                        </Badge>
                      )}
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <label htmlFor="github-setup-target-path" className="mb-1 block text-sm font-medium">
              前缀地址（工作根目录）
            </label>
            <input
              id="github-setup-target-path"
              type="text"
              aria-label="前缀地址"
              value={targetPath}
              onChange={(event) => setTargetPath(event.target.value)}
              placeholder="/root/workspace"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="mt-1 break-words text-xs text-muted-foreground">
              项目将 clone 到 {normalizedPrefix === null ? '<前缀>' : normalizedPrefix}/&lt;User/Repo&gt;
            </p>
            {prefixError !== null && (
              <p className="mt-1 text-xs text-destructive">{prefixError}</p>
            )}
            {normalizedPrefix !== null && (
              <p className="mt-1 break-all text-xs text-muted-foreground">
                最终 clone 地址：{finalClonePath ?? '—'}
              </p>
            )}
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
              {submitting ? '提交中...' : '开始设置'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
