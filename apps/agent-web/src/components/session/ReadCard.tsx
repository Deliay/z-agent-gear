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

  const locations = parsed.locations as ToolCallLocation[] | undefined;
  const contentText = (() => {
    const raw = parsed as Record<string, unknown>;
    const content = raw.content;
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object') {
      const c = content as Record<string, unknown>;
      return typeof c.content === 'string' ? c.content : '';
    }
    return '';
  })();
  const fileCount = locations?.length || 0;
  const firstFile = locations?.[0]?.path;
  const summary = firstFile
    ? `Read: ${firstFile}${fileCount > 1 ? ` +${fileCount - 1}` : ''}`
    : `Read ${fileCount} file${fileCount !== 1 ? 's' : ''}`;

  return (
    <AcpCard
      title="Read Files"
      summary={summary}
      defaultCollapsed={true}
      color="purple"
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <div className="space-y-3">
        {locations && locations.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-gray-500">Files read</div>
            <div className="space-y-1">
              {locations.map((loc, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-gray-700">
                  <span className="font-mono">{loc.path || '(unknown path)'}</span>
                  {loc.line != null && (
                    <span className="text-xs text-gray-400">:{loc.line}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {contentText && (
          <div>
            {locations && locations.length > 0 && (
              <div className="mb-1 text-xs font-medium text-gray-500">Content</div>
            )}
            <div className="rounded-md bg-white px-3 py-2 text-sm text-gray-700">
              <MarkdownContent content={contentText} />
            </div>
          </div>
        )}
      </div>
    </AcpCard>
  );
}
