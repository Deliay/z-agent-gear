import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { GET_GITHUB_ACCOUNTS, CLOUD_HOST_WORKLOADS } from '../../graphql/queries'
import { SETUP_CLOUD_HOST_GITHUB_PROJECT } from '../../graphql/mutations'
import type {
  CloudHostData,
  CloudHostWorkloadItemData,
  CloudHostWorkloadsQuery,
  GetGithubAccountsQuery,
  GitHubRepoData,
  SetupCloudHostGithubProjectMutation,
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

function isGithubPreset(workload: CloudHostWorkloadItemData): boolean {
  return workload.isPreset && workload.name === 'Github'
}

function mergeRepos(installations: GetGithubAccountsQuery['githubAccounts'][number]['installations']): GitHubRepoData[] {
  const byFullName = new Map<string, GitHubRepoData>()
  for (const installation of installations ?? []) {
    for (const repo of installation.repos ?? []) {
      if (!byFullName.has(repo.fullName)) byFullName.set(repo.fullName, repo)
    }
  }
  return [...byFullName.values()]
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
  const [accountId, setAccountId] = useState('')
  const [repoFullName, setRepoFullName] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [selectedWorkloadIds, setSelectedWorkloadIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)

  const [setupGithubProject] = useMutation<SetupCloudHostGithubProjectMutation>(
    SETUP_CLOUD_HOST_GITHUB_PROJECT,
  )

  const {
    data: accountsData,
    loading: accountsLoading,
  } = useQuery<GetGithubAccountsQuery>(GET_GITHUB_ACCOUNTS, {
    skip: !open,
    fetchPolicy: 'cache-and-network',
  })

  const { data: workloadsData, loading: workloadsLoading } = useQuery<CloudHostWorkloadsQuery>(
    CLOUD_HOST_WORKLOADS,
    {
      variables: { controllerId },
      skip: !open,
      fetchPolicy: 'cache-and-network',
    },
  )

  const accounts = useMemo(
    () => accountsData?.githubAccounts ?? [],
    [accountsData],
  )
  const workloads = useMemo(
    () => workloadsData?.cloudHostWorkloads ?? [],
    [workloadsData],
  )
  const githubPresetId = useMemo(
    () => workloads.find(isGithubPreset)?.workloadId,
    [workloads],
  )

  const selectedAccount = accounts.find((account) => account.id === accountId)
  const repos = mergeRepos(selectedAccount?.installations)

  useEffect(() => {
    if (!open) return
    setAccountId('')
    setRepoFullName('')
    setTargetPath(cloudHost.defaultWorkspace ?? '')
    setSelectedWorkloadIds([])
    setSubmitting(false)
    setError(null)
    setOperationId(null)
    // 仅在打开时重置；cloudHost 变化由父组件重新挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Github 预制工作负载固定选中且不可取消；保留用户已勾选的其他负载
  useEffect(() => {
    if (!open) return
    setSelectedWorkloadIds((prev) => {
      const others = prev.filter((id) => id !== githubPresetId)
      return githubPresetId ? [githubPresetId, ...others] : others
    })
  }, [open, githubPresetId])

  // 默认选中第一个已绑定账号
  useEffect(() => {
    if (!open) return
    if (accounts.length === 0) return
    if (accounts.some((account) => account.id === accountId)) return
    setAccountId(accounts[0].id)
  }, [open, accounts, accountId])

  const hostRunning = cloudHost.status === 'RUNNING' && !cloudHost.deletedAt
  const trimmedTargetPath = targetPath.trim()
  const targetPathValid = trimmedTargetPath.startsWith('/')
  const hasAccounts = accounts.length > 0
  const submitDisabled =
    submitting ||
    !hostRunning ||
    !hasAccounts ||
    !accountId ||
    !repoFullName ||
    !targetPathValid

  const handleAccountChange = (nextAccountId: string) => {
    setAccountId(nextAccountId)
    setRepoFullName('')
  }

  const toggleWorkload = (workloadId: string, checked: boolean) => {
    setSelectedWorkloadIds((prev) =>
      checked ? [...prev.filter((id) => id !== workloadId), workloadId] : prev.filter((id) => id !== workloadId),
    )
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitDisabled) return

    setSubmitting(true)
    setError(null)
    try {
      const { data } = await setupGithubProject({
        variables: {
          input: {
            controllerId,
            accountId,
            repoFullName,
            targetPath: trimmedTargetPath,
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

          {accountsLoading && !accountsData ? (
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
                onChange={(event) => handleAccountChange(event.target.value)}
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
            {workloadsLoading && !workloadsData ? (
              <p className="text-sm text-muted-foreground">正在加载工作负载...</p>
            ) : workloads.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可选工作负载</p>
            ) : (
              <div className="space-y-2 rounded-md border border-border p-3">
                {workloads.map((workload) => {
                  const preset = isGithubPreset(workload)
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
              目标路径
            </label>
            <input
              id="github-setup-target-path"
              type="text"
              aria-label="目标路径"
              value={targetPath}
              onChange={(event) => setTargetPath(event.target.value)}
              placeholder="/root/workspace"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {targetPath.length > 0 && !targetPathValid && (
              <p className="mt-1 text-xs text-destructive">请输入绝对路径（以 / 开头）</p>
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
