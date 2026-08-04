import AcpCard from './AcpCard';
import MarkdownContent from './MarkdownContent';

interface ReadCardProps {
  messages: Array<{ content: string | Record<string, unknown>; createdAt: string }>;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

interface ToolCallLocation {
  path?: string;
  line?: number;
}

function parseMessage(content: string | Record<string, unknown>): Record<string, unknown> | null {
  if (typeof content === 'object') return content as Record<string, unknown>;
  try { return JSON.parse(content) as Record<string, unknown>; } catch { return null; }
}

export default function ReadCard({ messages, expanded, onExpandedChange }: ReadCardProps) {
  const last = messages[messages.length - 1];
  const parsed = parseMessage(last.content);
  if (!parsed) return null;

  const rawInput = parsed.rawInput as Record<string, unknown> | undefined;
  const rawOutput = parsed.rawOutput as Record<string, unknown> | undefined;
  const locations = parsed.locations as ToolCallLocation[] | undefined;
  const status = typeof parsed.status === 'string' ? parsed.status : 'in_progress';

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
      color={status === 'completed' ? 'blue' : status === 'failed' ? 'yellow' : 'purple'}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <div className="space-y-3">
        {filePaths.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Files read</div>
            <div className="space-y-1">
              {filePaths.map((path, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-foreground">
                  <span className="font-mono">{path}</span>
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
      </div>
    </AcpCard>
  );
}
