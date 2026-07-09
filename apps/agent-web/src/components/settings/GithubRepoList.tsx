import type { GitHubInstallationData } from '@/graphql/types'

interface Props {
  installation: GitHubInstallationData
}

export default function GithubRepoList({ installation }: Props) {
  return (
    <div className="rounded-md bg-muted p-3">
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        安装 ID: {installation.installationId}
      </div>
      <div className="space-y-1">
        {installation.repos && installation.repos.length > 0 ? (
          installation.repos.map(repo => (
            <div key={repo.id} className="flex items-center justify-between text-sm">
              <span>{repo.fullName}</span>
              <span className="text-xs text-muted-foreground">
                {repo.permissions.read && 'R'}
                {repo.permissions.write && 'W'}
                {repo.private && ' 🔒'}
              </span>
            </div>
          ))
        ) : (
          <div className="text-sm text-muted-foreground">暂无仓库</div>
        )}
      </div>
    </div>
  )
}
