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
    container: 'bg-purple-50 border border-purple-200',
    header: 'text-purple-800',
    summary: 'text-purple-600',
    chevron: 'text-purple-400 hover:text-purple-600',
  },
  yellow: {
    container: 'bg-yellow-50 border border-yellow-200',
    header: 'text-yellow-800',
    summary: 'text-yellow-600',
    chevron: 'text-yellow-400 hover:text-yellow-600',
  },
  gray: {
    container: 'bg-gray-100 border border-gray-200',
    header: 'text-gray-800',
    summary: 'text-gray-600',
    chevron: 'text-gray-400 hover:text-gray-600',
  },
  blue: {
    container: 'bg-blue-50 border border-blue-200',
    header: 'text-blue-800',
    summary: 'text-blue-600',
    chevron: 'text-blue-400 hover:text-blue-600',
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
