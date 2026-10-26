import { useState } from 'react'
import { ChevronDown, ChevronRight, GitPullRequest, MessageSquareText } from 'lucide-react'
import type {
  WorkflowAdditionalPromptData,
  WorkflowPullRequestLinkData,
} from '@/graphql/workflow'

interface WorkflowContextPanelProps {
  additionalPrompts: WorkflowAdditionalPromptData[]
  pullRequestLinks: WorkflowPullRequestLinkData[]
}

function Section({
  title,
  count,
  icon,
  emptyText,
  children,
}: {
  title: string
  count: number
  icon: React.ReactNode
  emptyText: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-semibold text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        {icon}
        {title}（{count}）
      </button>
      {open && (
        <div className="mt-2 min-w-0">
          {count === 0 ? (
            <p className="text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            <div className="space-y-2">{children}</div>
          )}
        </div>
      )}
    </div>
  )
}

/** 实例右栏只读面板：关联 Pull Request 与工作流追加提示词 */
export default function WorkflowContextPanel({
  additionalPrompts,
  pullRequestLinks,
}: WorkflowContextPanelProps) {
  return (
    <div className="min-w-0 space-y-4">
      <Section
        title="关联 Pull Request"
        count={pullRequestLinks.length}
        icon={<GitPullRequest className="size-3.5 text-muted-foreground" />}
        emptyText="暂无关联"
      >
        {pullRequestLinks.map((link) => (
          <div key={`${link.nodeId}-${link.pullRequestId}`} className="min-w-0 rounded-md border bg-muted/30 p-2">
            <div className="break-all text-xs font-medium text-foreground">{link.pullRequestId}</div>
            {link.nodeName && (
              <div className="mt-0.5 break-all text-xs text-muted-foreground">
                所属节点：{link.nodeName}
              </div>
            )}
            {link.prUrl && (
              <a
                href={link.prUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 block break-all text-xs text-primary hover:underline"
              >
                {link.prUrl}
              </a>
            )}
            <div className="mt-0.5 text-xs text-muted-foreground">
              关联时间：{link.registeredAt}
            </div>
            {link.checkRunUrl && (
              <div className="mt-0.5 break-all text-xs text-muted-foreground">
                检查项：
                <a
                  href={link.checkRunUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  {link.checkRunUrl}
                </a>
                {link.lastSyncAt && <> · 最近同步：{link.lastSyncAt}</>}
                {link.lastSyncedCommitSha && (
                  <> · 写入提交：{link.lastSyncedCommitSha.slice(0, 7)}</>
                )}
              </div>
            )}
            {link.lastSyncError && (
              <div className="mt-0.5 break-all text-xs text-destructive">{link.lastSyncError}</div>
            )}
          </div>
        ))}
      </Section>

      <Section
        title="追加提示词"
        count={additionalPrompts.length}
        icon={<MessageSquareText className="size-3.5 text-muted-foreground" />}
        emptyText="暂无"
      >
        {additionalPrompts.map((prompt) => (
          <div key={prompt.key} className="min-w-0 rounded-md border bg-muted/30 p-2">
            <div className="mb-1 break-all text-xs font-medium text-foreground">{prompt.key}</div>
            {/* 追加提示词可能来自外部审核意见：按普通文本渲染，不解析 Markdown */}
            <p className="min-w-0 whitespace-pre-wrap break-all text-xs text-muted-foreground">
              {prompt.value}
            </p>
          </div>
        ))}
      </Section>
    </div>
  )
}
