import { Badge } from '@/components/ui/badge';
import type { ResourceSource } from '@/lib/workspace-source';

/** 共享资源来源徽标：本工作区 / 全局工作区 / 其他工作区（无来源字段时不渲染）。 */
export function ResourceSourceBadge({ source }: { source: ResourceSource }) {
  if (!source.label) return null;
  return (
    <Badge
      variant={source.kind === 'workspace' ? 'outline' : 'secondary'}
      data-testid="resource-source-badge"
      data-source-kind={source.kind}
    >
      {source.label}
    </Badge>
  );
}
