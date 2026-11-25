import { Cpu, PencilIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDateTime } from '@/lib/format';
import type { AdminCloudSpecData } from '@/graphql/types';

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
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-0 text-sm">
        <thead className="bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">名称</th>
            <th className="px-4 py-2 font-medium">CPU</th>
            <th className="px-4 py-2 font-medium">内存（GiB）</th>
            <th className="px-4 py-2 font-medium">临时存储（GiB）</th>
            <th className="px-4 py-2 font-medium">白名单</th>
            <th className="px-4 py-2 font-medium">预制</th>
            <th className="px-4 py-2 font-medium">更新时间</th>
            <th className="px-4 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {specs.map((spec) => (
            <tr key={spec.id} className="border-t">
              <td className="px-4 py-3 font-medium text-foreground">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">{spec.name}</span>
                  {spec.unlimited && <Badge variant="outline">不限制</Badge>}
                </span>
              </td>
              <td className="px-4 py-3 text-muted-foreground tabular-nums">
                {resourceCell(spec, spec.cpu)}
              </td>
              <td className="px-4 py-3 text-muted-foreground tabular-nums">
                {resourceCell(spec, spec.memoryGi)}
              </td>
              <td className="px-4 py-3 text-muted-foreground tabular-nums">
                {resourceCell(spec, spec.ephemeralStorageGi)}
              </td>
              <td className="px-4 py-3">
                {spec.whitelistEnabled ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge variant="secondary">开启</Badge>
                    <span className="text-xs text-muted-foreground">
                      可见租户 {spec.allowedTenantIds.length}
                    </span>
                  </span>
                ) : (
                  <Badge variant="outline">关闭</Badge>
                )}
              </td>
              <td className="px-4 py-3">
                {spec.isPreset ? <Badge variant="secondary">预制</Badge> : '-'}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {formatDateTime(spec.updatedAt)}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
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
