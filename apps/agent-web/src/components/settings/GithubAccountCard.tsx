import { useState } from 'react'
import type { GitHubAccountData } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import GithubRepoList from './GithubRepoList'
import { ResourceSourceBadge } from './ResourceSourceBadge'
import type { ResourceSource } from '@/lib/workspace-source'

interface Props {
  account: GitHubAccountData
  onUnbind: (id: string) => void
  /** 全局工作区绑定在普通上下文只读；全局上下文 developer 整体只读 */
  readOnly?: boolean
  source?: ResourceSource
}

export default function GithubAccountCard({ account, onUnbind, readOnly = false, source }: Props) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-lg border p-4" data-testid="github-account-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {account.githubAvatarUrl && (
            <img
              src={account.githubAvatarUrl}
              alt=""
              className="h-8 w-8 rounded-full"
            />
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{account.githubLogin}</span>
              {source && <ResourceSourceBadge source={source} />}
            </div>
            <div className="text-xs text-muted-foreground">
              绑定于 {new Date(account.createdAt).toLocaleDateString()}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {account.installations && account.installations.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '收起仓库' : '查看仓库'}
            </Button>
          )}
          {!readOnly && account.installations && account.installations[0]?.managementUrl && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(account.installations![0]!.managementUrl, '_blank')}
            >
              更新绑定
            </Button>
          )}
          {!readOnly && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => onUnbind(account.id)}
            >
              解绑
            </Button>
          )}
        </div>
      </div>

      {expanded && account.installations && (
        <div className="mt-4 space-y-3">
          {account.installations.map(inst => (
            <GithubRepoList key={inst.id} installation={inst} />
          ))}
        </div>
      )}
    </div>
  )
}
