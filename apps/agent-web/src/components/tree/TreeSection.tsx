import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface TreeSectionProps {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  defaultExpanded?: boolean;
  children: React.ReactNode;
  emptyMessage?: string;
  hasContent?: boolean;
}

export default function TreeSection({
  title,
  count,
  actions,
  defaultExpanded = true,
  children,
  emptyMessage,
  hasContent,
}: TreeSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // hasContent 三态：
  // - undefined：尚未收到上报，照常渲染 children 让其挂载查询
  // - true：有内容，渲染 children
  // - false：无内容，渲染 emptyMessage（但仍挂载 children 以允许上报）
  const showChildren = hasContent === undefined || hasContent === true;

  return (
    <div className="py-1">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span>{title}</span>
          {count !== undefined && (
            <span className="rounded bg-muted px-1 py-0.5 text-[10px]">{count}</span>
          )}
        </button>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      {expanded && (
        <ul className="ml-2 border-l border-sidebar-border pl-2 space-y-0.5">
          {/* 始终挂载 children 以允许查询和上报 */}
          <li className={showChildren ? '' : 'hidden'} data-tree-content>
            {children}
          </li>
          {/* 空态提示：仅在 hasContent=false 时显示 */}
          {hasContent === false && emptyMessage && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">{emptyMessage}</li>
          )}
        </ul>
      )}
    </div>
  );
}