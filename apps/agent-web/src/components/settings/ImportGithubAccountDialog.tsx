import { useQuery } from '@apollo/client/react'
import { GET_PERSONAL_GITHUB_ACCOUNTS } from '@/graphql/queries'
import type {
  GetPersonalGithubAccountsQuery,
  PersonalGithubAccount,
} from '@/graphql/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface ImportGithubAccountDialogProps {
  open: boolean
  onClose: () => void
  /** 选择帐号后由调用方填充提交人用户名与 noreply 邮箱（仍可继续编辑）。 */
  onSelect: (account: PersonalGithubAccount) => void
}

/**
 * 「导入Github帐号信息」弹窗：列出个人租户绑定的 GitHub 帐号，供「Git」区块填充提交人。
 * 数据源 personalGithubAccounts（仅个人租户绑定，不含普通工作区副本）。
 */
export default function ImportGithubAccountDialog({
  open,
  onClose,
  onSelect,
}: ImportGithubAccountDialogProps) {
  const { data, loading } = useQuery<GetPersonalGithubAccountsQuery>(
    GET_PERSONAL_GITHUB_ACCOUNTS,
    { skip: !open },
  )

  const accounts = data?.personalGithubAccounts ?? []

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导入Github帐号信息</DialogTitle>
          <DialogDescription>
            选择个人帐号后填充提交人用户名与 noreply 邮箱，仍可继续编辑
          </DialogDescription>
        </DialogHeader>

        {loading && accounts.length === 0 ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : accounts.length === 0 ? (
          <div
            className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
            data-testid="import-github-account-empty"
          >
            先到『GitHub 绑定』绑定帐号
          </div>
        ) : (
          <ul className="space-y-2" aria-label="个人 Github 帐号列表">
            {accounts.map((account) => (
              <li key={account.id}>
                <button
                  type="button"
                  onClick={() => onSelect(account)}
                  className="flex w-full items-center gap-3 rounded-lg border p-2 text-left text-sm hover:bg-accent"
                >
                  {account.githubAvatarUrl ? (
                    <img
                      src={account.githubAvatarUrl}
                      alt={`${account.githubLogin} 头像`}
                      className="h-6 w-6 shrink-0 rounded-full"
                    />
                  ) : (
                    <span className="h-6 w-6 shrink-0 rounded-full bg-muted" aria-hidden="true" />
                  )}
                  <span className="min-w-0 truncate">{account.githubLogin}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
