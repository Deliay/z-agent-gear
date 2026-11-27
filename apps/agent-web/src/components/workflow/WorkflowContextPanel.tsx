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
    <section className="min-w-0 rounded-lg border border-border bg-card p-3">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label={`${title}（${count}）`}
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        {icon}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      </button>
      {open && (
        <div className="mt-2.5 min-w-0 border-t border-border pt-2.5">
          {count === 0 ? (
            <p className="text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border bg-muted/30">
              {children}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** 实例上下文只读面板：关联 Pull Request 与工作流追加提示词（列表右栏与画布抽屉共用） */
export default function WorkflowContextPanel({
  additionalPrompts,
  pullRequestLinks,
}: WorkflowContextPanelProps) {
  return (
    <div className="min-w-0 space-y-3">
      <Section
        title="关联 Pull Request"
        count={pullRequestLinks.length}
        icon={<GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />}
        emptyText="暂无关联"
      >
        {pullRequestLinks.map((link) => (
          <div key={`${link.nodeId}-${link.pullRequestId}`} className="min-w-0 p-2.5">
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
            <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
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
              <div className="mt-0.5 break-all text-xs text-destructive-text">{link.lastSyncError}</div>
            )}
          </div>
        ))}
      </Section>

      <Section
        title="追加提示词"
        count={additionalPrompts.length}
        icon={<MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />}
        emptyText="暂无"
      >
        {additionalPrompts.map((prompt) => (
          <div key={prompt.key} className="min-w-0 p-2.5">
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
