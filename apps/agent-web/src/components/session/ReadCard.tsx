import AcpCard from './AcpCard';
import MarkdownContent from './MarkdownContent';
import ToolCallRawSection from './ToolCallRawSection';
import ToolKindIcon from './tool-call-icons';
import { toolCallColor, type MergedToolCall } from './tool-call-state';

interface ReadCardProps {
  toolCall: MergedToolCall;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

interface ToolCallLocation {
  path?: string;
  line?: number;
}

export default function ReadCard({ toolCall, expanded, onExpandedChange }: ReadCardProps) {
  const rawInput = toolCall.rawInput as Record<string, unknown> | undefined;
  const rawOutput = toolCall.rawOutput as Record<string, unknown> | undefined;
  const locations = toolCall.locations as ToolCallLocation[] | undefined;
  const status = toolCall.status || 'in_progress';

  const filePath = (rawInput?.filePath as string) || locations?.[0]?.path || '';
  const filePaths: string[] = [];
  if (filePath) filePaths.push(filePath);
  if (locations) for (const loc of locations) { if (loc.path && !filePaths.includes(loc.path)) filePaths.push(loc.path); }

  const contentText = rawOutput?.output as string || '';

  const fileCount = filePaths.length;
  const summary = filePath
    ? `Read: ${filePath}${fileCount > 1 ? ` +${fileCount - 1}` : ''}`
    : `Read ${fileCount} file${fileCount !== 1 ? 's' : ''}`;

  return (
    <AcpCard
      title="Read Files"
      summary={summary}
      defaultCollapsed={true}
      color={toolCallColor(status)}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      icon={<ToolKindIcon kind="read" className="size-4" aria-hidden="true" />}
    >
      <div className="space-y-3">
        {filePaths.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Files read</div>
            <div className="space-y-1">
              {filePaths.map((path, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-foreground">
                  <span className="font-mono break-all">{path}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {contentText && (
          <div>
            {filePaths.length > 0 && (
              <div className="mb-1 text-xs font-medium text-muted-foreground">Content</div>
            )}
            <div className="rounded-md bg-background px-3 py-2 text-sm text-foreground">
              <MarkdownContent content={contentText} />
            </div>
          </div>
        )}
        <ToolCallRawSection label="输入" value={toolCall.rawInput} />
        <ToolCallRawSection label="输出" value={toolCall.rawOutput} />
      </div>
    </AcpCard>
  );
}
