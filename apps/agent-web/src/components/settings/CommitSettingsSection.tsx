import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { GET_COMMIT_SETTINGS, GET_GITHUB_ACCOUNTS } from '@/graphql/queries'
import { UPDATE_COMMIT_SETTINGS } from '@/graphql/mutations'
import type {
  CommitSettingsInputData,
  CommitterModeValue,
  CommitterTypeValue,
  GetCommitSettingsQuery,
  GetGithubAccountsQuery,
  UpdateCommitSettingsMutation,
} from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const MODE_OPTIONS: Array<{ value: CommitterModeValue; label: string }> = [
  { value: 'AGENT_ONLY', label: '仅Agent' },
  { value: 'CO_AUTHOR', label: 'Co-Author' },
  { value: 'HUMAN_ONLY', label: '仅人类' },
  { value: 'UNSET', label: '未设置' },
]

const TYPE_OPTIONS: Array<{ value: CommitterTypeValue; label: string }> = [
  { value: 'GITHUB_ACCOUNT', label: 'Github帐号' },
  { value: 'CUSTOM', label: '自定义' },
  { value: 'UNSET', label: '未设置' },
]

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 与服务端 commit-settings-service 同源的自定义提交人校验（裁决 2）。 */
function isValidCustomCommitter(name: string, email: string): boolean {
  const trimmedName = name.trim()
  const trimmedEmail = email.trim()
  if (!trimmedName || trimmedName.length > 100) return false
  if (/[\n\r\0]/.test(name)) return false
  if (!trimmedEmail || trimmedEmail.length > 254) return false
  return EMAIL_PATTERN.test(trimmedEmail)
}

/** 服务端白名单错误逐字映射（裁决 3）；未知错误原样展示。 */
function mapCommitSettingsError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (message.includes('committer is required for the selected mode')) {
    return '请先设置提交人'
  }
  if (message.includes('invalid github account')) {
    return 'Github 帐号无效，请重新选择'
  }
  if (message.includes('invalid custom committer')) {
    return '提交人用户名或邮箱格式不正确'
  }
  return message || '保存失败，请稍后重试'
}

/**
 * 设置页「Commit 设置」区块：提交人模式 × 提交人。
 * 仅对云容器环境生效；服务端校验为权威，前端拦截只做即时反馈。
 */
export default function CommitSettingsSection() {
  const { data: settingsData, loading: settingsLoading } = useQuery<GetCommitSettingsQuery>(
    GET_COMMIT_SETTINGS,
  )
  const { data: accountsData } = useQuery<GetGithubAccountsQuery>(GET_GITHUB_ACCOUNTS)
  const [saveCommitSettings, { loading: saving }] =
    useMutation<UpdateCommitSettingsMutation>(UPDATE_COMMIT_SETTINGS)

  const [committerMode, setCommitterMode] = useState<CommitterModeValue>('UNSET')
  const [committerType, setCommitterType] = useState<CommitterTypeValue>('UNSET')
  const [githubAccountId, setGithubAccountId] = useState<string>('')
  const [customName, setCustomName] = useState('')
  const [customEmail, setCustomEmail] = useState('')
  const [serverError, setServerError] = useState<string | null>(null)

  // 用户已编辑/已保存后，后台刷新不得覆盖表单（frontend-rules）
  const dirtyRef = useRef(false)
  const initializedRef = useRef(false)

  const commitSettings = settingsData?.commitSettings
  const accounts = accountsData?.githubAccounts ?? []
  const accountsReady = accountsData != null

  useEffect(() => {
    if (!commitSettings || initializedRef.current) return
    initializedRef.current = true
    if (dirtyRef.current) return
    setCommitterMode(commitSettings.committerMode)
    setCommitterType(commitSettings.committerType)
    setGithubAccountId(commitSettings.githubAccountId ?? '')
    setCustomName(commitSettings.customName ?? '')
    setCustomEmail(commitSettings.customEmail ?? '')
  }, [commitSettings])

  const selectedAccount = accounts.find((account) => account.id === githubAccountId)

  const blockingMessage = (() => {
    if (
      (committerMode === 'CO_AUTHOR' || committerMode === 'HUMAN_ONLY') &&
      committerType === 'UNSET'
    ) {
      return '请先设置提交人'
    }
    if (committerType === 'GITHUB_ACCOUNT') {
      if (!githubAccountId) {
        return accounts.length === 0 ? '请先绑定 Github 帐号' : '请选择 Github 帐号'
      }
      if (accountsReady && !selectedAccount) {
        return '已选择的 Github 帐号已解绑，请重新选择提交人'
      }
    }
    if (committerType === 'CUSTOM' && !isValidCustomCommitter(customName, customEmail)) {
      return '提交人用户名或邮箱格式不正确'
    }
    return null
  })()

  const markDirty = () => {
    dirtyRef.current = true
    setServerError(null)
  }

  const handleSave = async () => {
    if (blockingMessage || saving) return
    setServerError(null)
    const input: CommitSettingsInputData = {
      committerMode,
      committerType,
      githubAccountId: null,
      customName: null,
      customEmail: null,
    }
    if (committerType === 'GITHUB_ACCOUNT') {
      input.githubAccountId = githubAccountId
    } else if (committerType === 'CUSTOM') {
      input.customName = customName.trim()
      input.customEmail = customEmail.trim()
    }

    try {
      const result = await saveCommitSettings({ variables: { input } })
      const saved = result?.data?.updateCommitSettings
      if (saved) {
        // 回显服务端权威返回；保持 dirty 避免旧查询缓存把表单改回去
        dirtyRef.current = true
        setCommitterMode(saved.committerMode)
        setCommitterType(saved.committerType)
        setGithubAccountId(saved.githubAccountId ?? '')
        setCustomName(saved.customName ?? '')
        setCustomEmail(saved.customEmail ?? '')
      }
      setServerError(null)
      toast.success('对云容器环境生效，已运行的云电脑稍后自动更新')
    } catch (error) {
      setServerError(mapCommitSettingsError(error))
    }
  }

  if (settingsLoading && !settingsData) {
    return <div className="text-sm text-muted-foreground">加载中...</div>
  }

  return (
    <section className="space-y-4 border-t pt-6" data-testid="commit-settings-section">
      <div>
        <h3 className="text-lg font-medium text-foreground">Commit 设置</h3>
        <p className="mt-1 text-sm text-muted-foreground">设置只对云容器环境生效</p>
      </div>

      <div className="space-y-2" role="radiogroup" aria-label="提交人模式">
        <Label>提交人模式</Label>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {MODE_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="committer-mode"
                value={option.value}
                checked={committerMode === option.value}
                onChange={() => {
                  markDirty()
                  setCommitterMode(option.value)
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2" role="radiogroup" aria-label="提交人">
        <Label>提交人</Label>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {TYPE_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="committer-type"
                value={option.value}
                checked={committerType === option.value}
                onChange={() => {
                  markDirty()
                  setCommitterType(option.value)
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      {committerType === 'GITHUB_ACCOUNT' && (
        <div className="space-y-2">
          <Label htmlFor="commit-settings-github-account">Github 帐号</Label>
          <div className="flex items-center gap-3">
            <select
              id="commit-settings-github-account"
              aria-label="Github 帐号"
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={githubAccountId}
              onChange={(event) => {
                markDirty()
                setGithubAccountId(event.target.value)
              }}
            >
              <option value="">请选择 Github 帐号</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.githubLogin}
                </option>
              ))}
            </select>
            {selectedAccount && (
              <span className="flex min-w-0 shrink-0 items-center gap-2 text-sm text-foreground">
                {selectedAccount.githubAvatarUrl && (
                  <img
                    src={selectedAccount.githubAvatarUrl}
                    alt={`${selectedAccount.githubLogin} 头像`}
                    className="h-6 w-6 rounded-full"
                  />
                )}
                <span className="min-w-0 truncate">{selectedAccount.githubLogin}</span>
              </span>
            )}
          </div>
        </div>
      )}

      {committerType === 'CUSTOM' && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Label htmlFor="commit-settings-custom-name">用户名</Label>
            <Input
              id="commit-settings-custom-name"
              value={customName}
              maxLength={100}
              onChange={(event) => {
                markDirty()
                setCustomName(event.target.value)
              }}
            />
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="commit-settings-custom-email">邮箱</Label>
            <Input
              id="commit-settings-custom-email"
              type="email"
              value={customEmail}
              maxLength={254}
              onChange={(event) => {
                markDirty()
                setCustomEmail(event.target.value)
              }}
            />
          </div>
        </div>
      )}

      {blockingMessage && (
        <p className="break-words text-xs text-warning">{blockingMessage}</p>
      )}
      {serverError && (
        <p role="alert" className="break-words text-sm text-destructive">
          {serverError}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => {
            void handleSave()
          }}
          disabled={Boolean(blockingMessage) || saving}
        >
          {saving ? '保存中...' : '保存 Commit 设置'}
        </Button>
      </div>
    </section>
  )
}
