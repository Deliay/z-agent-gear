import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface AcpCardProps {
  title: string;
  summary: string;
  defaultCollapsed?: boolean;
  color?: 'purple' | 'yellow' | 'gray' | 'blue';
  children: React.ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

const colorClasses = {
  purple: {
    container: 'bg-muted border border-border',
    header: 'text-foreground',
    summary: 'text-muted-foreground',
    chevron: 'text-muted-foreground hover:text-foreground',
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
          <ChevronRight className={`h-4 w-4 ${colors.chevron}`} />
        ) : (
          <ChevronDown className={`h-4 w-4 ${colors.chevron}`} />
        )}
        <span className="font-medium text-sm">{title}</span>
        {collapsed && (
          <span className={`ml-auto text-xs ${colors.summary}`}>{summary}</span>
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
