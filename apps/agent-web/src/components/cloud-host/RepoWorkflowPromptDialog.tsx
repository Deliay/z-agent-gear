import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { RepoWorkflowTemplateData } from '@/graphql/workflow'
import { markRepoWorkflowPrompted } from '@/stores/repo-workflow-prompt'

interface RepoWorkflowPromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  /** 检测到的合法模板（非空才应弹出） */
  templates: RepoWorkflowTemplateData[]
  /** 「去配置」：父级打开配置弹窗并预选第一个模板 */
  onConfigure: (template: RepoWorkflowTemplateData) => void
}

/**
 * 新增工作目录 / GitHub 项目设置成功后的检测提示：
 * 列出合法模板名，「去配置」（预选第一个模板）或「取消」。
 * 两种选择都会记入会话内记忆，同一工作区不再自动弹（设置区块常驻入口不受影响）。
 */
export default function RepoWorkflowPromptDialog({
  open,
  onOpenChange,
  workspaceId,
  templates,
  onConfigure,
}: RepoWorkflowPromptDialogProps) {
  const handleCancel = () => {
    markRepoWorkflowPrompted(workspaceId)
    onOpenChange(false)
  }

  const handleConfigure = () => {
    const first = templates[0]
    if (!first) return
    markRepoWorkflowPrompted(workspaceId)
    onOpenChange(false)
    onConfigure(first)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : handleCancel())}>
      <DialogContent className="sm:max-w-md" data-testid="repo-workflow-prompt-dialog">
        <DialogHeader>
          <DialogTitle>检测到项目工作流模板</DialogTitle>
          <DialogDescription>
            当前项目仓库中存在 {templates.length} 个可配置的工作流模板，是否立即配置？
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5" data-testid="repo-workflow-prompt-list">
          {templates.map((template) => (
            <li key={template.fileName} className="rounded-md border px-3 py-2 text-sm">
              <div className="font-medium">{template.name ?? template.fileName}</div>
              <div className="truncate text-xs text-muted-foreground">{template.fileName}</div>
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            取消
          </Button>
          <Button onClick={handleConfigure}>去配置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
