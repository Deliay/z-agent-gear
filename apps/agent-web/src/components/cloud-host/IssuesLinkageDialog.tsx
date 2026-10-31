import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { GET_GITHUB_ACCOUNTS } from '../../graphql/queries'
import {
  GET_CONFIGURED_WORKFLOWS,
  type GetConfiguredWorkflowsQuery,
} from '../../graphql/workflow'
import {
  CREATE_CLOUD_HOST_ISSUES_LINKAGE,
  UPDATE_CLOUD_HOST_ISSUES_LINKAGE,
} from '../../graphql/mutations'
import type {
  CloudHostIssuesLinkageData,
  CreateCloudHostIssuesLinkageMutation,
  GetGithubAccountsQuery,
  UpdateCloudHostIssuesLinkageMutation,
} from '../../graphql/types'
import { mergeGithubRepos } from '../../hooks/useGithubProjectForm'
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

const LABEL_MAX = 50

interface IssuesLinkageDialogProps {
  open: boolean
  controllerId: string
  /** 编辑态：传入现有配置；新建为 null/undefined */
  linkage?: CloudHostIssuesLinkageData | null
  onClose: () => void
  onSaved: () => void
  /** 无可用工作流时跳转工作流配置入口 */
  onConfigureWorkflow?: () => void
}

/** 默认标签名 `start-{工作流名字}`（截断 50） */
export function defaultLinkageLabel(workflowName: string): string { // eslint-disable-line react-refresh/only-export-components
  return `start-${workflowName}`.trim().slice(0, LABEL_MAX)
}

/** 标签名前端校验（与服务端同口径：非空、≤50、不含逗号） */
export function validateLinkageLabel(labelName: string): string | null { // eslint-disable-line react-refresh/only-export-components
  const value = labelName.trim()
  if (!value) return '标签名不能为空'
  if (value.length > LABEL_MAX) return `标签名不能超过 ${LABEL_MAX} 个字符`
  if (value.includes(',')) return '标签名不能包含逗号'
  return null
}

export default function IssuesLinkageDialog({
  open,
  controllerId,
  linkage,
  onClose,
  onSaved,
  onConfigureWorkflow,
}: IssuesLinkageDialogProps) {
  const editing = Boolean(linkage)
  const [workflowId, setWorkflowId] = useState('')
  const [labelName, setLabelName] = useState('')
  const [labelDirty, setLabelDirty] = useState(false)
  const [selectedRepos, setSelectedRepos] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: workflowsData } = useQuery<GetConfiguredWorkflowsQuery>(
    GET_CONFIGURED_WORKFLOWS,
    { variables: { controllerId }, skip: !open, fetchPolicy: 'cache-and-network' },
  )
  const { data: accountsData } = useQuery<GetGithubAccountsQuery>(GET_GITHUB_ACCOUNTS, {
    skip: !open,
  })

  const workflows = useMemo(
    () =>
      (workflowsData?.configuredWorkflows ?? []).filter((workflow) =>
        (workflow.nodes ?? []).some((node) => node.type === 'HUMAN'),
      ),
    [workflowsData],
  )
  const repos = useMemo(
    () => mergeGithubRepos((accountsData?.githubAccounts ?? []).flatMap((a) => a.installations ?? [])),
    [accountsData],
  )

  const [createLinkage] = useMutation<CreateCloudHostIssuesLinkageMutation>(
    CREATE_CLOUD_HOST_ISSUES_LINKAGE,
  )
  const [updateLinkage] = useMutation<UpdateCloudHostIssuesLinkageMutation>(
    UPDATE_CLOUD_HOST_ISSUES_LINKAGE,
  )

  useEffect(() => {
    if (!open) return
    setSubmitting(false)
    setError(null)
    setWorkflowId(linkage?.configuredWorkflowId ?? '')
    setLabelName(linkage?.labelName ?? '')
    setLabelDirty(Boolean(linkage))
    setSelectedRepos(linkage?.repoFullNames ?? [])
  }, [open, linkage])

  const selectedWorkflow = workflows.find((workflow) => workflow.id === workflowId)

  useEffect(() => {
    if (!open || labelDirty || !selectedWorkflow) return
    setLabelName(defaultLinkageLabel(selectedWorkflow.name))
  }, [open, labelDirty, selectedWorkflow])

  useEffect(() => {
    if (!open || editing || workflowId || workflows.length === 0) return
    setWorkflowId(workflows[0].id)
  }, [open, editing, workflowId, workflows])

  const labelError = validateLinkageLabel(labelName)
  const canSubmit =
    !submitting &&
    Boolean(workflowId) &&
    !labelError &&
    selectedRepos.length > 0 &&
    workflows.length > 0

  const toggleRepo = (fullName: string, checked: boolean) => {
    setSelectedRepos((current) =>
      checked
        ? current.includes(fullName) ? current : [...current, fullName]
        : current.filter((item) => item !== fullName),
    )
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    const input = {
      controllerId,
      configuredWorkflowId: workflowId,
      labelName: labelName.trim(),
      repoFullNames: selectedRepos,
    }
    try {
      if (linkage) {
        await updateLinkage({ variables: { id: linkage.id, input } })
      } else {
        await createLinkage({ variables: { input } })
      }
      onSaved()
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : '保存失败，请稍后重试'
      setError(message)
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑 Issue 联动配置' : '加 Issue 联动配置'}</DialogTitle>
          <DialogDescription>
            选择工作流并确认标签，确认后会把标签同步到所选仓库。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="issue-linkage-workflow" className="text-sm font-medium">工作流</label>
            {workflows.length === 0 ? (
              <div className="mt-1 space-y-2 text-sm text-muted-foreground">
                <p>暂无包含人类节点的工作流。</p>
                {onConfigureWorkflow && (
                  <Button type="button" size="sm" variant="outline" onClick={onConfigureWorkflow}>
                    配置工作流
                  </Button>
                )}
              </div>
            ) : (
              <select
                id="issue-linkage-workflow"
                aria-label="工作流"
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
              >
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="issue-linkage-label" className="text-sm font-medium">标签名</label>
            <Input
              id="issue-linkage-label"
              aria-label="标签名"
              className="mt-1"
              value={labelName}
              placeholder="start-工作流名字"
              onChange={(event) => {
                setLabelDirty(true)
                setLabelName(event.target.value)
              }}
            />
            {labelError && <p className="mt-1 text-xs text-destructive">{labelError}</p>}
            {editing && (
              <p className="mt-1 text-xs text-muted-foreground">旧标签将保留在仓库中但不再触发。</p>
            )}
          </div>

          <div>
            <span className="text-sm font-medium">仓库</span>
            {repos.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                未找到可用仓库，请先在设置页绑定 Github 帐号。
              </p>
            ) : (
              <div className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {repos.map((repo) => (
                  <label key={repo.fullName} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={repo.fullName}
                      checked={selectedRepos.includes(repo.fullName)}
                      onChange={(event) => toggleRepo(repo.fullName, event.target.checked)}
                    />
                    <span className="break-all">{repo.fullName}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <p className="text-sm text-muted-foreground" data-testid="issue-linkage-sync-hint">
            确认后将把标签 <span className="font-medium">{labelName.trim() || '（未填写）'}</span> 同步到所选仓库
          </p>

          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
              {error.startsWith('label sync failed:') && (
                <span className="mt-1 block text-xs">
                  配置已保存，失败仓库：{error.slice('label sync failed:'.length).trim()}。可重试同步。
                </span>
              )}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? '保存中...' : error ? '重试保存' : '保存配置'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
