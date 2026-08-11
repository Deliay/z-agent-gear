import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface AcpCardProps {
  title: string;
  summary: string;
  defaultCollapsed?: boolean;
  // purple/yellow/gray/blue 为历史配色（仅 purple 高亮）；
  // active/completed/failed 为工具调用恒高亮配色：info 同色系按状态区分强度。
  color?: 'purple' | 'yellow' | 'gray' | 'blue' | 'active' | 'completed' | 'failed';
  children: React.ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

const colorClasses = {
  purple: {
    container: 'bg-info/10 border border-info motion-safe:animate-pulse',
    header: 'text-info',
    summary: 'text-info',
    chevron: 'text-info hover:opacity-70',
  },
  yellow: {
    container: 'bg-muted border border-border',
    header: 'text-foreground',
    summary: 'text-muted-foreground',
    chevron: 'text-muted-foreground hover:text-foreground',
  },
  gray: {
    container: 'bg-muted border border-border',
    header: 'text-foreground',
    summary: 'text-muted-foreground',
    chevron: 'text-muted-foreground hover:text-foreground',
  },
  blue: {
    container: 'bg-muted border border-border',
    header: 'text-foreground',
    summary: 'text-muted-foreground',
    chevron: 'text-muted-foreground hover:text-foreground',
  },
  // 恒高亮：进行中最强（脉冲），完成/失败减弱为同色系浅高亮，失败摘要用 destructive 略微区分
  active: {
    container: 'bg-info/10 border border-info motion-safe:animate-pulse',
    header: 'text-info',
    summary: 'text-info',
    chevron: 'text-info hover:opacity-70',
  },
  completed: {
    container: 'bg-info/5 border border-info/40',
    header: 'text-info',
    summary: 'text-info/70',
    chevron: 'text-info/70 hover:opacity-70',
  },
  failed: {
    container: 'bg-info/5 border border-info/40',
    header: 'text-info',
    summary: 'text-destructive',
    chevron: 'text-info/70 hover:opacity-70',
  },
};

export default function AcpCard({
  title,
  summary,
  defaultCollapsed = true,
  color = 'gray',
  children,
  expanded,
  onExpandedChange,
}: AcpCardProps) {
  const isControlled = expanded !== undefined;
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const collapsed = isControlled ? !expanded : internalCollapsed;
  const colors = colorClasses[color];

  const toggle = () => {
    if (isControlled) {
      onExpandedChange?.(!expanded);
    } else {
      setInternalCollapsed(!internalCollapsed);
    }
  };

  return (
    <div className={`rounded-lg overflow-hidden ${colors.container}`}>
      <button
        type="button"
        onClick={toggle}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left ${colors.header} hover:opacity-80 transition-opacity`}
      >
        {collapsed ? (
          <ChevronRight className={`h-4 w-4 shrink-0 ${colors.chevron}`} />
        ) : (
          <ChevronDown className={`h-4 w-4 shrink-0 ${colors.chevron}`} />
        )}
        <span className="min-w-0 truncate font-medium text-sm">{title}</span>
        {collapsed && (
          <span className={`ml-auto min-w-0 truncate text-xs ${colors.summary}`}>{summary}</span>
        )}
      </button>
      {!collapsed && (
        <div className="px-3 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}
