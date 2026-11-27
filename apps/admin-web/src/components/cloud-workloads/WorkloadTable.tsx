import { Boxes, PencilIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDateTime } from '@/lib/format';
import type { CloudWorkloadData } from '@/graphql/types';
import * as T from '@/lib/table-styles'

interface WorkloadTableProps {
  workloads: CloudWorkloadData[];
  onEdit: (workload: CloudWorkloadData) => void;
  onDelete: (workload: CloudWorkloadData) => void;
}

// 脚本摘要：单行展示，靠 CSS truncate 截断（避免撑破窄容器）
function scriptSummary(script: string | null): string {
  const text = (script ?? '').trim();
  return text || '-';
}

export default function WorkloadTable({ workloads, onEdit, onDelete }: WorkloadTableProps) {
  if (workloads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed">
        <EmptyState
          icon={Boxes}
          title="暂无工作负载"
          description="点击「新建工作负载」定义初始化/清理脚本，供启动容器时挂载"
        />
      </div>
    );
  }

  const nameById = new Map(workloads.map((workload) => [workload.id, workload.name]));

  return (
    <div className={T.TABLE_CONTAINER_CLASS}>
      <table className={T.TABLE_CLASS}>
        <thead>
          <tr className={T.TABLE_HEAD_CLASS}>
            <th className={T.TABLE_HEAD_CELL_CLASS}>名称</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>类型</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>参数</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>依赖</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>初始化脚本</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>清理脚本</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>更新时间</th>
            <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>操作</th>
          </tr>
        </thead>
        <tbody>
          {workloads.map((workload) => {
            const dependencyNames = (workload.dependsOnWorkloadIds ?? []).map(
              (id) => nameById.get(id) ?? id,
            );
            const paramCount = (workload.paramSchema ?? []).length;
            return (
              <tr key={workload.id} className={T.TABLE_ROW_CLASS}>
                <td className={T.TABLE_CELL_STRONG_CLASS}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{workload.name}</span>
                    {workload.isPreset && <Badge variant="info">预制</Badge>}
                  </span>
                </td>
                <td className={T.TABLE_CELL_MUTED_CLASS}>
                  <Badge variant="outline">
                    {(workload.workloadKind ?? 'STANDARD') === 'HARNESS' ? 'HARNESS' : 'STANDARD'}
                  </Badge>
                </td>
                <td className={T.TABLE_CELL_MUTED_CLASS}>
                  {paramCount > 0 ? paramCount : '-'}
                </td>
                <td className={T.TABLE_CELL_MUTED_CLASS}>
                  {dependencyNames.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {dependencyNames.map((depName) => (
                        <span
                          key={depName}
                          className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
                        >
                          {depName}
                        </span>
                      ))}
                    </span>
                  ) : (
                    '-'
                  )}
                </td>
                <td className={T.TABLE_CELL_MUTED_CLASS}>
                  <span className="block max-w-xs truncate">{scriptSummary(workload.initScript)}</span>
                </td>
                <td className={T.TABLE_CELL_MUTED_CLASS}>
                  <span className="block max-w-xs truncate">{scriptSummary(workload.postScript)}</span>
                </td>
                <td className={T.TABLE_CELL_MUTED_CLASS}>
                  {formatDateTime(workload.updatedAt)}
                </td>
                <td className={T.TABLE_CELL_CLASS}>
                  <div className={T.TABLE_ACTION_CLASS}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`编辑 ${workload.name}`}
                      onClick={() => onEdit(workload)}
                    >
                      <PencilIcon className="size-4" />
                    </Button>
                    <Button
                      variant="ghost-danger"
                      size="icon-sm"
                      aria-label={`删除 ${workload.name}`}
                      onClick={() => onDelete(workload)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
