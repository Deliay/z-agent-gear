import { Badge } from '@/components/ui/badge';
import { useWorkspaceAccess } from '@/stores/workspace';

/**
 * 设置页工作区上下文提示：
 * 明确当前资源所属工作区，并在「全局工作区 + developer」时提示整体只读。
 */
export default function WorkspaceContextBanner() {
  const { workspace, readOnly } = useWorkspaceAccess();
  if (!workspace) return null;
  return (
    <div
      className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
      data-testid="workspace-context-banner"
    >
      <span className="text-muted-foreground">当前工作区</span>
      <span className="font-medium text-foreground">{workspace.name}</span>
      <Badge variant={workspace.type === 'global' ? 'secondary' : 'outline'}>
        {workspace.type === 'global' ? '全局工作区' : '普通工作区'}
      </Badge>
      {readOnly && (
        <Badge variant="destructive" data-testid="workspace-readonly-badge">
          只读
        </Badge>
      )}
      {readOnly && (
        <span className="text-xs text-muted-foreground">
          全局工作区对开发者只读，编辑入口已隐藏
        </span>
      )}
    </div>
  );
}
