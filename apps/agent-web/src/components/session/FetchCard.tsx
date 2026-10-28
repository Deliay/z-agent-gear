import AcpCard from './AcpCard';
import MarkdownContent from './MarkdownContent';
import ToolCallRawSection from './ToolCallRawSection';
import ToolKindIcon from './tool-call-icons';
import { toolCallColor, type MergedToolCall } from './tool-call-state';

interface FetchCardProps {
  toolCall: MergedToolCall;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export default function FetchCard({ toolCall, expanded, onExpandedChange }: FetchCardProps) {
  const rawInput = toolCall.rawInput as Record<string, unknown> | undefined;
  const rawOutput = toolCall.rawOutput as Record<string, unknown> | undefined;
  const status = toolCall.status || 'in_progress';
  const url = typeof rawInput?.url === 'string' ? rawInput.url : '';
  const output = typeof rawOutput?.output === 'string' ? rawOutput.output : '';
  const summary = url ? `Fetch: ${url.length > 40 ? url.slice(0, 40) + '...' : url}` : 'Fetch URL';

  return (
    <AcpCard
      title="Fetch URL"
      summary={summary}
      defaultCollapsed={true}
      color={toolCallColor(status)}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      icon={<ToolKindIcon kind="fetch" className="size-4" aria-hidden="true" />}
    >
      <div className="space-y-3">
        {url && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">URL</div>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate rounded-md bg-background px-3 py-2 text-sm text-primary underline hover:text-primary/80"
            >
              {url}
            </a>
          </div>
        )}
        {output && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Result</div>
            <div className="rounded-md bg-background px-3 py-2 text-sm text-foreground">
              <MarkdownContent content={output} />
            </div>
          </div>
        )}
        <ToolCallRawSection label="输入" value={toolCall.rawInput} />
        <ToolCallRawSection label="输出" value={toolCall.rawOutput} />
      </div>
    </AcpCard>
  );
}
