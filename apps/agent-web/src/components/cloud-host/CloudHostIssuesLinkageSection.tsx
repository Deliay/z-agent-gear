import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { CLOUD_HOST_ISSUES_LINKAGES } from '../../graphql/queries'
import { DELETE_CLOUD_HOST_ISSUES_LINKAGE } from '../../graphql/mutations'
import type {
  CloudHostIssuesLinkageData,
  CloudHostIssuesLinkagesQuery,
  DeleteCloudHostIssuesLinkageMutation,
} from '../../graphql/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import IssuesLinkageDialog from './IssuesLinkageDialog'

interface CloudHostIssuesLinkageSectionProps {
  controllerId: string
  /** 无可用工作流时跳转工作流配置入口 */
  onConfigureWorkflow?: () => void
}

/**
 * 云电脑配置页「Github」区块：Issue 联动配置列表 + 新增/编辑/删除。
 * 懒查询：仅在区块挂载（用户切到该 tab）时拉取。
 */
export default function CloudHostIssuesLinkageSection({
  controllerId,
  onConfigureWorkflow,
}: CloudHostIssuesLinkageSectionProps) {
  const { data, loading, error, refetch } = useQuery<CloudHostIssuesLinkagesQuery>(
    CLOUD_HOST_ISSUES_LINKAGES,
    { variables: { controllerId }, fetchPolicy: 'cache-and-network' },
  )
  const [deleteLinkage] = useMutation<DeleteCloudHostIssuesLinkageMutation>(
    DELETE_CLOUD_HOST_ISSUES_LINKAGE,
  )

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CloudHostIssuesLinkageData | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const linkages = data?.cloudHostIssuesLinkages ?? []

  const handleDelete = async (id: string) => {
    setDeleteError(null)
    try {
      await deleteLinkage({ variables: { id } })
      setPendingDelete(null)
      await refetch()
    } catch (err) {
      setDeleteError(err instanceof Error && err.message ? err.message : '删除失败，请稍后重试')
    }
  }

  return (
    <div className="min-w-0 space-y-4" data-testid="issues-linkage-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          为 Issue 打上配置的标签即可自动触发对应工作流；首个含 Issue 内容的人类节点会自动完成。
        </p>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          加 Issue 联动配置
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive">加载联动配置失败，可重试。</p>
      ) : loading && !data ? (
        <p className="text-sm text-muted-foreground">加载中...</p>
      ) : linkages.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          暂无 Issue 联动配置。
        </p>
      ) : (
        <ul className="space-y-2">
          {linkages.map((linkage) => (
            <li
              key={linkage.id}
              className="rounded-lg border p-3"
              data-testid={`issues-linkage-item-${linkage.id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{linkage.configuredWorkflowName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    标签：<Badge variant="secondary">{linkage.labelName}</Badge>
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing(linkage)
                      setDialogOpen(true)
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setPendingDelete(linkage.id)}
                  >
                    删除
                  </Button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {linkage.repoFullNames.map((repo) => (
                  <Badge key={repo} variant="outline" className="max-w-full break-all">
                    {repo}
                  </Badge>
                ))}
              </div>
              {pendingDelete === linkage.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-sm">
                  <span>删除后该配置不再触发，仓库标签保留，确认删除？</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    aria-label={`确认删除 ${linkage.labelName}`}
                    onClick={() => { void handleDelete(linkage.id) }}
                  >
                    确认删除
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setPendingDelete(null)}>
                    取消
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {deleteError && (
        <p role="alert" className="break-words text-sm text-destructive">{deleteError}</p>
      )}

      <IssuesLinkageDialog
        open={dialogOpen}
        controllerId={controllerId}
        linkage={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          setDialogOpen(false)
          void refetch()
        }}
        onConfigureWorkflow={onConfigureWorkflow}
      />
    </div>
  )
}
