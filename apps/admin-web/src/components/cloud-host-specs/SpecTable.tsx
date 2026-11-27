import { Cpu, PencilIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDateTime } from '@/lib/format';
import type { AdminCloudSpecData } from '@/graphql/types';
import * as T from '@/lib/table-styles'

interface SpecTableProps {
  specs: AdminCloudSpecData[];
  onEdit: (spec: AdminCloudSpecData) => void;
  onDelete: (spec: AdminCloudSpecData) => void;
}

function resourceCell(spec: AdminCloudSpecData, value: number): string | number {
  return spec.unlimited ? '不限制' : value;
}

export default function SpecTable({ specs, onEdit, onDelete }: SpecTableProps) {
  if (specs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed">
        <EmptyState
          icon={Cpu}
          title="暂无容器规格"
          description="点击「新建规格」定义云电脑算力档位，并按租户白名单控制前台可见性"
        />
      </div>
    );
  }

  return (
    <div className={T.TABLE_CONTAINER_CLASS}>
      <table className={T.TABLE_CLASS}>
        <thead>
          <tr className={T.TABLE_HEAD_CLASS}>
            <th className={T.TABLE_HEAD_CELL_CLASS}>名称</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>CPU</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>内存（GiB）</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>临时存储（GiB）</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>白名单</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>预制</th>
            <th className={T.TABLE_HEAD_CELL_CLASS}>更新时间</th>
            <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>操作</th>
          </tr>
        </thead>
        <tbody>
          {specs.map((spec) => (
            <tr key={spec.id} className={T.TABLE_ROW_CLASS}>
              <td className={T.TABLE_CELL_STRONG_CLASS}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">{spec.name}</span>
                  {spec.unlimited && <Badge variant="outline">不限制</Badge>}
                </span>
              </td>
              <td className={T.TABLE_CELL_NUMERIC_CLASS}>
                {resourceCell(spec, spec.cpu)}
              </td>
              <td className={T.TABLE_CELL_NUMERIC_CLASS}>
                {resourceCell(spec, spec.memoryGi)}
              </td>
              <td className={T.TABLE_CELL_NUMERIC_CLASS}>
                {resourceCell(spec, spec.ephemeralStorageGi)}
              </td>
              <td className={T.TABLE_CELL_CLASS}>
                {spec.whitelistEnabled ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge variant="success">开启</Badge>
                    <span className="text-xs text-muted-foreground">
                      可见租户 {spec.allowedTenantIds.length}
                    </span>
                  </span>
                ) : (
                  <Badge variant="muted">关闭</Badge>
                )}
              </td>
              <td className={T.TABLE_CELL_CLASS}>
                {spec.isPreset ? <Badge variant="info">预制</Badge> : '-'}
              </td>
              <td className={T.TABLE_CELL_MUTED_CLASS}>
                {formatDateTime(spec.updatedAt)}
              </td>
              <td className={T.TABLE_CELL_CLASS}>
                <div className={T.TABLE_ACTION_CLASS}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`编辑 ${spec.name}`}
                    onClick={() => onEdit(spec)}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost-danger"
                    size="icon-sm"
                    aria-label={`删除 ${spec.name}`}
                    onClick={() => onDelete(spec)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
