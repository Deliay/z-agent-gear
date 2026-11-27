import {
  Archive,
  ArchiveRestore,
  GitBranch,
  GitPullRequest,
  Layers,
  List,
  MoreHorizontal,
  Pencil,
  Server,
  Trash2,
} from 'lucide-react';
import MobileBackButton from '@/components/MobileBackButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPopup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { WorkflowInstanceData } from '@/graphql/workflow';
import { NODE_STATUS_BADGE, NODE_STATUS_LABELS } from './WorkflowNodeTreeConstants';

export interface WorkflowTopBarProps {
  instance: WorkflowInstanceData;
  viewMode: 'list' | 'graph';
  onViewModeChange: (mode: 'list' | 'graph') => void;
  onOpenRename: () => void;
  onOpenInspector: () => void;
  onArchive: () => void;
  onOpenDelete: () => void;
}

/**
 * 工作流实例详情页单行顶部上下文栏（对齐 UI 规范 §4.2 / §6-D）：
 * - 左侧：返回按钮、实例名 + 内联重命名、当前执行状态、节点完成进度（tabular-nums）、环境信息胶囊、关联 PR 快捷徽标
 * - 右侧：分段视图切换器（列表/图表）、实例资源抽屉入口、更多操作菜单（归档/删除）
 */
export default function WorkflowTopBar({
  instance,
  viewMode,
  onViewModeChange,
  onOpenRename,
  onOpenInspector,
  onArchive,
  onOpenDelete,
}: WorkflowTopBarProps) {
  const doneCount = instance.nodes.filter((node) => node.status === 'DONE').length;
  const totalCount = instance.nodes.length;
  const resourceCount =
    instance.blackboard.length +
    instance.pullRequestLinks.length +
    instance.additionalPrompts.length;

  const envLabel =
    instance.workspace?.name ||
    instance.controller?.name ||
    instance.workflowWorktreeBranch ||
    null;

  return (
    <header
      data-testid="workflow-top-bar"
      className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/60 px-4 py-2"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <MobileBackButton to="/sessions" />
        <h1 className="min-w-0 max-w-full truncate text-base font-semibold text-foreground sm:max-w-xs md:max-w-md">
          {instance.name}
        </h1>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="重命名实例"
          title="重命名实例"
          onClick={onOpenRename}
        >
          <Pencil className="size-3.5" />
        </Button>

        {instance.currentNodeNames.length > 0 ? (
          instance.currentNodeNames.map((name) => (
            <Badge key={name} variant="default">
              执行中：{name}
            </Badge>
          ))
        ) : instance.lastNodeName && instance.lastNodeStatus ? (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${NODE_STATUS_BADGE[instance.lastNodeStatus]}`}
          >
            {instance.lastNodeName} · {NODE_STATUS_LABELS[instance.lastNodeStatus]}
          </span>
        ) : (
          <Badge variant="secondary">暂无执行中的节点</Badge>
        )}

        <span
          data-testid="workflow-progress-badge"
          className="inline-flex shrink-0 items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
        >
          已完成 {doneCount}/{totalCount}
        </span>

        {envLabel && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="workflow-env-capsule"
                className="inline-flex max-w-44 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Server className="size-3 shrink-0" />
                <span className="truncate">{envLabel}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-2 p-3">
              <div className="text-xs font-semibold text-foreground">运行环境信息</div>
              <div className="space-y-1.5 text-xs">
                {instance.controller?.name && (
                  <div className="flex items-start justify-between gap-2">
                    <span className="shrink-0 text-muted-foreground">控制器</span>
                    <span className="min-w-0 wrap-anywhere text-right text-foreground">
                      {instance.controller.name}
                    </span>
                  </div>
                )}
                {instance.workspace?.name && (
                  <div className="flex items-start justify-between gap-2">
                    <span className="shrink-0 text-muted-foreground">工作区</span>
                    <span className="min-w-0 wrap-anywhere text-right text-foreground">
                      {instance.workspace.name}
                    </span>
                  </div>
                )}
                {instance.workflowWorktreeBranch && (
                  <div className="flex items-start justify-between gap-2">
                    <span className="shrink-0 text-muted-foreground">分支</span>
                    <span className="min-w-0 wrap-anywhere text-right font-mono text-foreground">
                      {instance.workflowWorktreeBranch}
                    </span>
                  </div>
                )}
                {instance.workflowWorktreePath && (
                  <div className="flex items-start justify-between gap-2">
                    <span className="shrink-0 text-muted-foreground">目录</span>
                    <span className="min-w-0 wrap-anywhere text-right font-mono text-muted-foreground">
                      {instance.workflowWorktreePath}
                    </span>
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {instance.pullRequestLinks.length > 0 && (
          <button
            type="button"
            onClick={onOpenInspector}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium tabular-nums text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="查看关联 Pull Request"
          >
            <GitPullRequest className="size-3 shrink-0" />
            <span>PR {instance.pullRequestLinks.length}</span>
          </button>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <div
          role="group"
          aria-label="视图切换"
          className="inline-flex items-center rounded-lg border border-border bg-background p-0.5"
        >
          <Button
            variant={viewMode === 'list' ? 'default' : 'ghost'}
            size="xs"
            onClick={() => onViewModeChange('list')}
            aria-pressed={viewMode === 'list'}
          >
            <List className="size-3.5" />
            列表
          </Button>
          <Button
            variant={viewMode === 'graph' ? 'default' : 'ghost'}
            size="xs"
            onClick={() => onViewModeChange('graph')}
            aria-pressed={viewMode === 'graph'}
          >
            <GitBranch className="size-3.5" />
            图表
          </Button>
        </div>

        {viewMode === 'graph' && (
          <Button
            variant="outline"
            size="sm"
            data-testid="workflow-inspector-toggle"
            onClick={onOpenInspector}
          >
            <Layers className="size-3.5" />
            <span>实例资源</span>
            {resourceCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0 text-xs tabular-nums text-muted-foreground">
                {resourceCount}
              </span>
            )}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                data-testid="workflow-more-actions"
                aria-label="更多操作"
                title="更多操作"
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuPopup>
            <DropdownMenuItem onClick={onArchive}>
              {instance.archived ? (
                <>
                  <ArchiveRestore className="size-3.5" />
                  <span>取消归档</span>
                </>
              ) : (
                <>
                  <Archive className="size-3.5" />
                  <span>归档</span>
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive-text data-highlighted:bg-destructive/10 data-highlighted:text-destructive-text"
              onClick={onOpenDelete}
            >
              <Trash2 className="size-3.5" />
              <span>删除实例</span>
            </DropdownMenuItem>
          </DropdownMenuPopup>
        </DropdownMenu>
      </div>
    </header>
  );
}
