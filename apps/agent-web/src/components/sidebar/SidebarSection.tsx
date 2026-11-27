import type React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SidebarSectionKey } from '@/lib/sidebar-prefs';

/**
 * 侧边栏全宽可折叠分区（类 VSCode）：标题行占满侧边栏，点击切换，右侧 actions。
 * 由 `Sidebar` 与 `components/knowledge-base/KnowledgeBaseSection` 共用。
 */
export default function SidebarSection({
  sectionKey,
  title,
  count,
  actions,
  expanded,
  onToggle,
  children,
}: {
  sectionKey: SidebarSectionKey;
  title: string;
  count?: number;
  actions?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-sidebar-border/60 py-0.5" data-testid={`sidebar-section-${sectionKey}`}>
      <div className="flex w-full items-center gap-1 rounded px-2 py-1.5 transition-colors hover:bg-sidebar-accent/60">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={title}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold tracking-wide text-muted-foreground hover:text-foreground"
          onClick={onToggle}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-normal tabular-nums">{count}</span>
          )}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {expanded && <div data-testid={`sidebar-section-content-${sectionKey}`} className="mt-0.5">{children}</div>}
    </section>
  );
}
