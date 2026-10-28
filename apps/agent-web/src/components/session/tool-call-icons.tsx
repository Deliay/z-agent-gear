import {
  ArrowRightLeft,
  Brain,
  FilePen,
  FileSearch,
  Globe,
  Hammer,
  Search,
  TerminalSquare,
  Trash2,
  type LucideProps,
} from 'lucide-react';

interface ToolKindIconProps extends LucideProps {
  kind?: string;
}

/** ToolKind → lucide 图标；未识别类型回退 Hammer */
export default function ToolKindIcon({ kind, ...props }: ToolKindIconProps) {
  switch (kind) {
    case 'read':
      return <FileSearch {...props} />;
    case 'edit':
      return <FilePen {...props} />;
    case 'delete':
      return <Trash2 {...props} />;
    case 'move':
      return <ArrowRightLeft {...props} />;
    case 'search':
      return <Search {...props} />;
    case 'execute':
      return <TerminalSquare {...props} />;
    case 'think':
      return <Brain {...props} />;
    case 'fetch':
      return <Globe {...props} />;
    case 'switch_mode':
      return <ArrowRightLeft {...props} />;
    case 'other':
    default:
      return <Hammer {...props} />;
  }
}
