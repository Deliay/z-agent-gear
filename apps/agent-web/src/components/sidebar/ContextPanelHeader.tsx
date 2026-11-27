import type React from 'react';
import { Search, X } from 'lucide-react';
import WorkspaceSwitcher from '../WorkspaceSwitcher';
import type { ContextDomainKey } from '@/lib/sidebar-prefs';

export interface ContextPanelHeaderProps {
  activeDomain: ContextDomainKey;
  title: string;
  count?: number;
  action?: React.ReactNode;
  showFilter?: boolean;
  filterQuery?: string;
  onFilterChange?: (value: string) => void;
  mobile?: boolean;
  onSelectDomain?: (domain: ContextDomainKey) => void;
}

const MOBILE_DOMAINS: Array<{ key: ContextDomainKey; label: string }> = [
  { key: 'sessions', label: '会话' },
  { key: 'workflows', label: '工作流' },
  { key: 'knowledgeBases', label: '知识库' },
  { key: 'hosts', label: '主机' },
];

/**
 * 上下文列表栏顶部固定区：
 * - 租户/工作区切换器
 * - 移动端紧凑 4 领域切换栏（桌面端由 ActivityRail 承担）
 * - 领域标题 + 等宽计数徽标 + 领域主操作按钮
 * - 会话/工作流领域轻量本地关键词筛选框
 */
export default function ContextPanelHeader({
  activeDomain,
  title,
  count,
  action,
  showFilter = false,
  filterQuery = '',
  onFilterChange,
  mobile = false,
  onSelectDomain,
}: ContextPanelHeaderProps) {
  return (
    <div
      data-testid="context-panel-header"
      className="shrink-0 space-y-2 border-b border-sidebar-border px-3 py-2.5"
    >
      <WorkspaceSwitcher />

      {mobile && onSelectDomain && (
        <div
          role="tablist"
          aria-label="切换领域"
          data-testid="mobile-domain-tabs"
          className="grid grid-cols-4 gap-1 rounded-lg border border-sidebar-border bg-background/60 p-0.5"
        >
          {MOBILE_DOMAINS.map((item) => {
            const active = item.key === activeDomain;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelectDomain(item.key)}
                className={`rounded-md px-1.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? 'bg-card text-primary shadow-2xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="truncate text-xs font-semibold tracking-wide text-muted-foreground">
            {title}
          </h2>
          {count !== undefined && (
            <span
              data-testid="context-panel-count"
              className="shrink-0 rounded-full bg-card px-1.5 py-0.5 text-xs font-medium tabular-nums text-foreground ring-1 ring-sidebar-border"
            >
              {count}
            </span>
          )}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
      </div>

      {showFilter && onFilterChange && (
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            data-testid="context-panel-filter"
            value={filterQuery}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder={`筛选${title}...`}
            aria-label={`筛选${title}`}
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {filterQuery && (
            <button
              type="button"
              aria-label="清空筛选"
              title="清空筛选"
              onClick={() => onFilterChange('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
