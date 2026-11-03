import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface TreeSectionProps {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  defaultExpanded?: boolean;
  children: React.ReactNode;
  /**
   * 空态文案：**本期不再渲染**（PRD 功能点 4「空态收敛」）。
   * 入参保留以兼容存量调用方，避免逐个删除调用点。
   */
  emptyMessage?: string;
  hasContent?: boolean;
  /** 层级缩进级别：每级 0.5rem（≈2 个空格），与主机树层级视觉统一 */
  level?: number;
}

export default function TreeSection({
  title,
  count,
  actions,
  defaultExpanded = true,
  children,
  hasContent,
  level = 0,
}: TreeSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // 计算是否有内容
  const childCount = React.Children.count(children);
  // hasContent 三态：
  // - undefined：尚未收到上报，按 Children.count 回退判断
  // - true：有内容
  // - false：无内容
  const hasActualContent = hasContent !== undefined ? hasContent : childCount > 0;

  return (
    <div className="py-0.5" style={{ paddingLeft: `${level * 0.5}rem` }} data-tree-level={level}>
      <div className="flex w-full items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-sidebar-accent/60">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]">{count}</span>
          )}
        </button>
        {actions && <div className="ml-auto shrink-0">{actions}</div>}
      </div>
      {expanded && (
        <ul className="mt-0.5 ml-2 space-y-0.5 border-l border-sidebar-border pl-1">
          {/* 始终挂载 children 以允许查询和上报，使用 ul > li > ul > li 合法结构 */}
          <li className={hasActualContent ? '' : 'hidden'} data-tree-content>
            <ul>{children}</ul>
          </li>
          {/* 空态收敛：无内容时不渲染「无会话」等占位文字，保留可展开空容器 */}
        </ul>
      )}
    </div>
  );
}
