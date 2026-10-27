import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { CLOUD_HOST_WORKLOADS, GET_GITHUB_ACCOUNTS } from '../graphql/queries'
import type {
  CloudHostWorkloadItemData,
  CloudHostWorkloadsQuery,
  GetGithubAccountsQuery,
  GitHubRepoData,
} from '../graphql/types'
import {
  normalizeWorkspacePrefixForPreview,
  previewClonePath,
  workspacePrefixError,
} from '../lib/workspace-path'

/** 云电脑预制的 Github 工作负载（固定选中且不可取消） */
export function isGithubPresetWorkload(workload: CloudHostWorkloadItemData): boolean {
  return Boolean(workload.isPreset) && workload.name === 'Github'
}

/** 合并所有 installation 的仓库，按 fullName 去重 */
export function mergeGithubRepos(
  installations: GetGithubAccountsQuery['githubAccounts'][number]['installations'],
): GitHubRepoData[] {
  const byFullName = new Map<string, GitHubRepoData>()
  for (const installation of installations ?? []) {
    for (const repo of installation.repos ?? []) {
      if (!byFullName.has(repo.fullName)) byFullName.set(repo.fullName, repo)
    }
  }
  return [...byFullName.values()]
}

export interface GithubProjectFormOptions {
  /** 弹窗/区块是否处于打开状态；关闭期间不做重置与查询 */
  open: boolean
  controllerId: string
  /** 前缀地址默认值（cloudHost.defaultWorkspace） */
  defaultWorkspace?: string | null
  /**
   * 是否已创建默认工作区（CloudHost.hasDefaultWorkspace）。
   * true → 预填 `defaultWorkspace`；false/未传 → 预填 `~/workspace`（新建云电脑流程兜底）。
   */
  hasDefaultWorkspace?: boolean | null
  /**
   * 云电脑尚未创建时（新建云电脑流程）没有 controllerId，无法查询工作负载列表，
   * 此时只收集账号/仓库/前缀，工作负载由服务端 setup 时自动补 Github 预制项。
   */
  includeWorkloads?: boolean
  /** 云电脑已锁定的 Github 帐号；非空时表单固定为该帐号且不可修改 */
  lockedAccountId?: string | null
}

export interface GithubProjectFormState {
  accounts: GetGithubAccountsQuery['githubAccounts']
  accountsLoading: boolean
  workloads: CloudHostWorkloadItemData[]
  workloadsLoading: boolean
  accountId: string
  setAccountId: (id: string) => void
  repoFullName: string
  setRepoFullName: (fullName: string) => void
  repos: GitHubRepoData[]
  targetPath: string
  setTargetPath: (path: string) => void
  selectedWorkloadIds: string[]
  toggleWorkload: (workloadId: string, checked: boolean) => void
  githubPresetId: string | undefined
  prefixError: string | null
  normalizedPrefix: string | null
  finalClonePath: string | null
  hasAccounts: boolean
  /** 已锁定帐号不在当前账号列表中（授权失效）；仍保持置灰、不允许换绑 */
  lockedAccountMissing: boolean
  /** 账号 + 仓库 + 合法前缀（云电脑侧另需 host RUNNING） */
  isValid: boolean
}

/**
 * Git 项目设置表单：Github 账号 → 仓库 → 前缀地址（只读预览最终 clone 地址）。
 * 供「Github 项目设置」对话框与「新建云电脑」对话框共用。
 */
export function useGithubProjectForm({
  open,
  controllerId,
  defaultWorkspace,
  hasDefaultWorkspace,
  includeWorkloads = true,
  lockedAccountId = null,
}: GithubProjectFormOptions): GithubProjectFormState {
  const [accountId, setAccountIdState] = useState('')
  const [repoFullName, setRepoFullNameState] = useState('')
  const [targetPath, setTargetPathState] = useState('')
  const [selectedWorkloadIds, setSelectedWorkloadIds] = useState<string[]>([])

  const { data: accountsData, loading: accountsLoading } = useQuery<GetGithubAccountsQuery>(
    GET_GITHUB_ACCOUNTS,
    {
      skip: !open,
      fetchPolicy: 'cache-and-network',
    },
  )

  const { data: workloadsData, loading: workloadsLoading } = useQuery<CloudHostWorkloadsQuery>(
    CLOUD_HOST_WORKLOADS,
    {
      variables: { controllerId },
      skip: !open || !includeWorkloads || !controllerId,
      fetchPolicy: 'cache-and-network',
    },
  )

  const accounts = useMemo(() => accountsData?.githubAccounts ?? [], [accountsData])
  const workloads = useMemo(
    () => (includeWorkloads ? workloadsData?.cloudHostWorkloads ?? [] : []),
    [includeWorkloads, workloadsData],
  )
  const githubPresetId = useMemo(
    () => workloads.find(isGithubPresetWorkload)?.workloadId,
    [workloads],
  )

  // 打开时重置；有默认工作区（hasDefaultWorkspace=true）预填 defaultWorkspace，
  // 无默认工作区（false）或新建云电脑流程（未传）统一预填 `~/workspace`（裁决 3）
  useEffect(() => {
    if (!open) return
    setAccountIdState('')
    setRepoFullNameState('')
    setTargetPathState(
      hasDefaultWorkspace === true ? (defaultWorkspace ?? '~/workspace') : '~/workspace',
    )
    setSelectedWorkloadIds([])
    // 仅在打开时重置，避免父组件轮询刷新时覆盖用户输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Github 预制工作负载固定选中且不可取消；保留用户已勾选的其他负载
  useEffect(() => {
    if (!open || !includeWorkloads) return
    setSelectedWorkloadIds((prev) => {
      const others = prev.filter((id) => id !== githubPresetId)
      return githubPresetId ? [githubPresetId, ...others] : others
    })
  }, [open, includeWorkloads, githubPresetId])

  // 锁定帐号优先固定；未锁定时默认选中第一个已绑定账号
  useEffect(() => {
    if (!open) return
    if (lockedAccountId) {
      if (accountId !== lockedAccountId) setAccountIdState(lockedAccountId)
      return
    }
    if (accounts.length === 0) return
    if (accounts.some((account) => account.id === accountId)) return
    setAccountIdState(accounts[0].id)
  }, [open, accounts, accountId, lockedAccountId])

  const effectiveAccountId = lockedAccountId || accountId
  const selectedAccount = accounts.find((account) => account.id === effectiveAccountId)
  const repos = useMemo(() => mergeGithubRepos(selectedAccount?.installations), [selectedAccount])

  const setAccountId = (nextAccountId: string) => {
    if (lockedAccountId) return
    setAccountIdState(nextAccountId)
    setRepoFullNameState('')
  }

  const toggleWorkload = (workloadId: string, checked: boolean) => {
    setSelectedWorkloadIds((prev) =>
      checked
        ? [...prev.filter((id) => id !== workloadId), workloadId]
        : prev.filter((id) => id !== workloadId),
    )
  }

  const prefixError = workspacePrefixError(targetPath)
  const normalizedPrefix = normalizeWorkspacePrefixForPreview(targetPath)
  const finalClonePath = previewClonePath(targetPath, repoFullName)
  const hasAccounts = accounts.length > 0
  const lockedAccountMissing =
    Boolean(lockedAccountId) &&
    !accountsLoading &&
    !accounts.some((account) => account.id === lockedAccountId)
  const isValid =
    hasAccounts &&
    Boolean(effectiveAccountId) &&
    Boolean(repoFullName) &&
    prefixError === null &&
    normalizedPrefix !== null

  return {
    accounts,
    accountsLoading,
    workloads,
    workloadsLoading,
    accountId: effectiveAccountId,
    setAccountId,
    repoFullName,
    setRepoFullName: setRepoFullNameState,
    repos,
    targetPath,
    setTargetPath: setTargetPathState,
    selectedWorkloadIds,
    toggleWorkload,
    githubPresetId,
    prefixError,
    normalizedPrefix,
    finalClonePath,
    hasAccounts,
    lockedAccountMissing,
    isValid,
  }
}

export default useGithubProjectForm
