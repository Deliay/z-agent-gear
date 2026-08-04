import AcpCard from './AcpCard';
import MarkdownContent from './MarkdownContent';

interface SubAgentCardProps {
  messages: Array<{ content: string | Record<string, unknown>; createdAt: string }>;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

function parseMessage(content: string | Record<string, unknown>): Record<string, unknown> | null {
  if (typeof content === 'object') return content as Record<string, unknown>;
  try { return JSON.parse(content) as Record<string, unknown>; } catch { return null; }
}

export default function SubAgentCard({ messages, expanded, onExpandedChange }: SubAgentCardProps) {
  const last = messages[messages.length - 1];
  const parsed = parseMessage(last.content);
  if (!parsed) return null;

  const rawInput = parsed.rawInput as Record<string, unknown> | undefined;
  const rawOutput = parsed.rawOutput as Record<string, unknown> | undefined;
  const status = typeof parsed.status === 'string' ? parsed.status : 'in_progress';
  const description = typeof rawInput?.description === 'string' ? rawInput.description : '';
  const prompt = typeof rawInput?.prompt === 'string' ? rawInput.prompt : '';
  const output = typeof rawOutput?.output === 'string' ? rawOutput.output : '';
  const subagentType = typeof rawInput?.subagent_type === 'string' ? rawInput.subagent_type : 'sub-agent';
  const title = description || `Sub Agent: ${subagentType}`;
  const summary = `${subagentType}${description ? ': ' + description : ''}`;

  return (
    <AcpCard
      title={title}
      summary={summary}
      defaultCollapsed={true}
      color={status === 'completed' ? 'blue' : status === 'failed' ? 'yellow' : 'purple'}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <div className="space-y-3">
        {prompt && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Prompt</div>
            <div className="rounded-md bg-background px-3 py-2 text-sm text-foreground">
              <MarkdownContent content={prompt} />
            </div>
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
