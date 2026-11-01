import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { GET_COMMIT_SETTINGS } from '@/graphql/queries'
import { UPDATE_COMMIT_SETTINGS } from '@/graphql/mutations'
import type {
  CommitSettings,
  CommitSettingsInput,
  CommitterType,
  GetCommitSettingsQuery,
  PersonalGithubAccount,
  UpdateCommitSettingsMutation,
} from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import ImportGithubAccountDialog from './ImportGithubAccountDialog'

const TYPE_OPTIONS: Array<{ value: CommitterType; label: string }> = [
  { value: 'CUSTOM', label: '自定义' },
  { value: 'UNSET', label: '未设置' },
]

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const INVALID_COMMITTER_MESSAGE = '提交人用户名或邮箱格式不正确'

/** 与服务端 commit-settings-service 同源的自定义提交人校验（trim 后 name ∈ (0,100]、email ≤254、禁换行/NUL、邮箱正则）。 */
function isValidCustomCommitter(name: string, email: string): boolean {
  const trimmedName = name.trim()
  const trimmedEmail = email.trim()
  if (!trimmedName || trimmedName.length > 100) return false
  if (!trimmedEmail || trimmedEmail.length > 254) return false
  if (/[\n\r\0]/.test(name) || /[\n\r\0]/.test(email)) return false
  return EMAIL_PATTERN.test(trimmedEmail)
}

/** 服务端白名单错误映射（收敛为单条 `invalid custom committer`）；未知错误原样展示。 */
function mapCommitSettingsError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (message.includes('invalid custom committer')) {
    return INVALID_COMMITTER_MESSAGE
  }
  return message || '保存失败，请稍后重试'
}

/**
 * 设置页「Git」区块：成员级提交人设置（自定义 / 未设置）。
 * 仅对云电脑环境生效；服务端校验为权威，前端拦截只做即时反馈。
 */
export default function GitSettingsSection() {
  const { data: settingsData, loading: settingsLoading } = useQuery<GetCommitSettingsQuery>(
    GET_COMMIT_SETTINGS,
    // CommitSettings 无 id 字段、Apollo 无法归一化 mutation 结果：必须显式回写 / 重拉缓存。
    // cache-and-network 保证卸载重挂载时不会用陈旧缓存初始化表单（先例 McpDefaultSection）。
    { fetchPolicy: 'cache-and-network' },
  )
  const [saveCommitSettings, { loading: saving }] =
    useMutation<UpdateCommitSettingsMutation>(UPDATE_COMMIT_SETTINGS, {
      // mutation 返回的 CommitSettings 无 id，Apollo 无法自动合并到 ROOT_QUERY.commitSettings；
      // 显式重拉以更新缓存，避免离开设置页再返回时回显旧值（先例 GithubBindingSection）。
      refetchQueries: [GET_COMMIT_SETTINGS],
    })

  const [committerType, setCommitterType] = useState<CommitterType>('UNSET')
  const [customName, setCustomName] = useState('')
  const [customEmail, setCustomEmail] = useState('')
  const [commitWithBot, setCommitWithBot] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  // 用户已编辑/已保存后，后台刷新不得覆盖表单（frontend-rules）
  const dirtyRef = useRef(false)

  const commitSettings = settingsData?.commitSettings

  // 未编辑时允许随缓存/网络结果刷新（cache-and-network 会先给缓存再给网络值，
  // 卸载重挂载后必须能被最新结果覆盖）；一旦用户编辑则不再自动覆盖。
  useEffect(() => {
    if (!commitSettings || dirtyRef.current) return
    setCommitterType(commitSettings.committerType)
    setCustomName(commitSettings.customName ?? '')
    setCustomEmail(commitSettings.customEmail ?? '')
    setCommitWithBot(commitSettings.commitWithBot)
  }, [commitSettings])

  const blockingMessage =
    committerType === 'CUSTOM' && !isValidCustomCommitter(customName, customEmail)
      ? INVALID_COMMITTER_MESSAGE
      : null

  const markDirty = () => {
    dirtyRef.current = true
    setServerError(null)
  }

  const echoSettings = (settings: CommitSettings) => {
    dirtyRef.current = true
    setCommitterType(settings.committerType)
    setCustomName(settings.customName ?? '')
    setCustomEmail(settings.customEmail ?? '')
    setCommitWithBot(settings.commitWithBot)
  }

  const handleImportSelect = (account: PersonalGithubAccount) => {
    markDirty()
    setCustomName(account.githubLogin)
    setCustomEmail(`${account.githubUserId}+${account.githubLogin}@users.noreply.github.com`)
    setImportOpen(false)
  }

  const handleSave = async () => {
    if (blockingMessage || saving) return
    setServerError(null)
    const input: CommitSettingsInput = {
      committerType,
      customName: null,
      customEmail: null,
      commitWithBot: committerType === 'CUSTOM' ? commitWithBot : false,
    }
    if (committerType === 'CUSTOM') {
      input.customName = customName.trim()
      input.customEmail = customEmail.trim()
    }

    try {
      const result = await saveCommitSettings({ variables: { input } })
      const saved = result?.data?.updateCommitSettings
      if (saved) {
        // 回显服务端权威返回；保持 dirty 避免旧查询缓存把表单改回去
        echoSettings(saved)
      }
      setServerError(null)
      toast.success('对成员的会话/工作流 Worktree 生效')
    } catch (error) {
      setServerError(mapCommitSettingsError(error))
    }
  }

  if (settingsLoading && !settingsData) {
    return <div className="text-sm text-muted-foreground">加载中...</div>
  }

  return (
    <section className="space-y-4 border-t pt-6" data-testid="git-settings-section">
      <div>
        <h3 className="text-lg font-medium text-foreground">Git</h3>
        <p className="mt-1 text-sm text-muted-foreground">仅对云电脑环境生效</p>
      </div>

      <div className="space-y-2" role="radiogroup" aria-label="提交人">
        <Label>提交人</Label>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {TYPE_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="git-committer-type"
                value={option.value}
                checked={committerType === option.value}
                onChange={() => {
                  markDirty()
                  setCommitterType(option.value)
                  if (option.value !== 'CUSTOM') setCommitWithBot(false)
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <label
          className={`flex items-center gap-2 text-sm ${
            committerType === 'CUSTOM' ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
          }`}
        >
          <input
            type="checkbox"
            name="git-commit-with-bot"
            checked={committerType === 'CUSTOM' && commitWithBot}
            disabled={committerType !== 'CUSTOM'}
            onChange={(event) => {
              markDirty()
              setCommitWithBot(event.target.checked)
            }}
          />
          <span>与 bot 共同提交</span>
        </label>
        {committerType !== 'CUSTOM' && (
          <p className="text-xs text-muted-foreground">设置提交人后可勾选</p>
        )}
      </div>

      {committerType === 'CUSTOM' && (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="git-settings-custom-name">用户名</Label>
              <Input
                id="git-settings-custom-name"
                value={customName}
                maxLength={100}
                onChange={(event) => {
                  markDirty()
                  setCustomName(event.target.value)
                }}
              />
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="git-settings-custom-email">邮箱</Label>
              <Input
                id="git-settings-custom-email"
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

          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setImportOpen(true)}
            >
              导入Github帐号信息
            </Button>
          </div>
        </>
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
          {saving ? '保存中...' : '保存 Git 设置'}
        </Button>
      </div>

      <ImportGithubAccountDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onSelect={handleImportSelect}
      />
    </section>
  )
}
