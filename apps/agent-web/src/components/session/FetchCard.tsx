import AcpCard from './AcpCard';
import MarkdownContent from './MarkdownContent';

interface FetchCardProps {
  messages: Array<{ content: string | Record<string, unknown>; createdAt: string }>;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

function parseMessage(content: string | Record<string, unknown>): Record<string, unknown> | null {
  if (typeof content === 'object') return content as Record<string, unknown>;
  try { return JSON.parse(content) as Record<string, unknown>; } catch { return null; }
}

export default function FetchCard({ messages, expanded, onExpandedChange }: FetchCardProps) {
  const last = messages[messages.length - 1];
  const parsed = parseMessage(last.content);
  if (!parsed) return null;

  const rawInput = parsed.rawInput as Record<string, unknown> | undefined;
  const rawOutput = parsed.rawOutput as Record<string, unknown> | undefined;
  const status = typeof parsed.status === 'string' ? parsed.status : 'in_progress';
  const url = typeof rawInput?.url === 'string' ? rawInput.url : '';
  const output = typeof rawOutput?.output === 'string' ? rawOutput.output : '';
  const summary = url ? `Fetch: ${url.length > 40 ? url.slice(0, 40) + '...' : url}` : 'Fetch URL';

  return (
    <AcpCard
      title="Fetch URL"
      summary={summary}
      defaultCollapsed={true}
      color={status === 'completed' ? 'blue' : status === 'failed' ? 'yellow' : 'purple'}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
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
      </div>
    </AcpCard>
  );
}
