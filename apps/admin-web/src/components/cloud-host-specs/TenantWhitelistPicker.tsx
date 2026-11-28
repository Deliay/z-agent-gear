import { useEffect, useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { XIcon } from 'lucide-react';
import { ADMIN_TENANTS } from '@/graphql/queries';
import type { GetAdminTenantsQuery } from '@/graphql/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SPEC_WHITELIST_MAX_TENANTS } from '@/lib/cloud-host-spec';

interface TenantWhitelistPickerProps {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

const PAGE_SIZE = 20;

/**
 * 白名单租户多选 combo：复用 `adminTenants(keyword, page, pageSize)` 关键字搜索 + 分页
 * （计划期裁决 D9，零契约新增）。已选租户以徽标展示，可逐枚移除；上限 200。
 */
export default function TenantWhitelistPicker({
  selectedIds,
  onChange,
}: TenantWhitelistPickerProps) {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  // 租户 ID → 名称缓存：跨页/跨搜索保留已选徽标的可读名称（编辑回填时未命中的 ID 回退展示 ID）
  const [nameById, setNameById] = useState<Record<string, string>>({});

  const { data, loading, error, refetch } = useQuery<GetAdminTenantsQuery>(ADMIN_TENANTS, {
    variables: { keyword: keyword.trim() || null, page, pageSize: PAGE_SIZE },
  });

  const tenants = data?.adminTenants ?? [];

  // 仅在新名称出现时更新缓存（无变化返回原状态，避免无谓渲染）
  useEffect(() => {
    const entries = (data?.adminTenants ?? []).map(
      (tenant) => [tenant.id, tenant.name] as const,
    );
    if (entries.length === 0) return;
    setNameById((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, name] of entries) {
        if (next[id] !== name) {
          next[id] = name;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [data]);

  const nameOf = (id: string): string => nameById[id] ?? id;
  const atLimit = selectedIds.length >= SPEC_WHITELIST_MAX_TENANTS;

  const toggle = (id: string, checked: boolean) => {
    if (checked) {
      if (selectedIds.includes(id) || atLimit) return;
      onChange([...selectedIds, id]);
    } else {
      onChange(selectedIds.filter((value) => value !== id));
    }
  };

  return (
    <div className="min-w-0 space-y-2">
      <Input
        aria-label="搜索租户"
        placeholder="按租户名称搜索"
        value={keyword}
        onChange={(event) => {
          setKeyword(event.target.value);
          // 关键字变化时重置页码，避免停留在旧范围的空页
          setPage(1);
        }}
      />

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedIds.map((id) => {
            const name = nameOf(id);
            return (
              <Badge key={id} variant="secondary" className="gap-1">
                <span className="max-w-40 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={`移除租户 ${name}`}
                  className="rounded-full text-muted-foreground hover:text-foreground"
                  onClick={() => toggle(id, false)}
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      {loading && !data ? (
        <p className="text-xs text-muted-foreground">租户加载中...</p>
      ) : error && !data ? (
        <div className="space-y-1">
          <p className="text-xs text-destructive-text">租户列表加载失败</p>
          <Button size="xs" variant="outline" onClick={() => void refetch()}>
            重试
          </Button>
        </div>
      ) : tenants.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无租户</p>
      ) : (
        <ScrollArea className="max-h-40 rounded-md border p-2">
          <ul className="space-y-1">
            {tenants.map((tenant) => {
              const checked = selectedIds.includes(tenant.id);
              return (
                <li key={tenant.id} className="flex min-w-0 items-center gap-2">
                  <Checkbox
                    aria-label={tenant.name}
                    checked={checked}
                    disabled={atLimit && !checked}
                    onCheckedChange={(value) => toggle(tenant.id, value === true)}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {tenant.name}
                  </span>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          已选 {selectedIds.length} / {SPEC_WHITELIST_MAX_TENANTS}
          {atLimit && <span className="text-destructive-text"> 已达上限</span>}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            上一页
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">第 {page} 页</span>
          <Button
            size="xs"
            variant="outline"
            disabled={tenants.length < PAGE_SIZE}
            onClick={() => setPage((current) => current + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}
