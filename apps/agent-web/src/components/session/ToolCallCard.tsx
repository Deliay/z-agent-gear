import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';
import DiffView from './DiffView';
import TerminalOutput from './TerminalOutput';

interface ToolCallCardProps {
  messages: Array<{ content: string | Record<string, unknown>; createdAt: string }>;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

interface EditRawInput {
  filePath?: string;
  oldString?: string;
  newString?: string;
}

interface ExecuteRawInput {
  workDir?: string;
  description?: string;
  command?: string;
  timeout?: number;
}

function parseMessage(content: string | Record<string, unknown>): SessionUpdate | null {
  if (typeof content === 'object') return content as SessionUpdate;
  try { return JSON.parse(content) as SessionUpdate; } catch { return null; }
}

function kindLabel(kind?: string): string {
  switch (kind) {
    case 'edit': return 'Edit';
    case 'execute': return 'Command';
    default: return kind || 'Tool Call';
  }
}

function renderContentItem(item: ToolCallContent, i: number) {
  if (item.type === 'content') {
    const cb = item.content;
    if (cb.type === 'text') {
      return (
        <div key={i} className="prose prose-sm max-w-none text-foreground">
          <div className="whitespace-pre-wrap">{cb.text}</div>
        </div>
      );
    }
    return null;
  }
  if (item.type === 'diff') {
    return (
      <div key={i} className="mb-2 last:mb-0">
        <DiffView
          oldText={item.oldText}
          newText={item.newText}
          filePath={item.path}
        />
      </div>
    );
  }
  if (item.type === 'terminal') {
    return (
      <div key={i} className="text-sm text-muted-foreground italic">
        Terminal: {item.terminalId}
      </div>
    );
  }
  return null;
}

export default function ToolCallCard({ messages, expanded, onExpandedChange }: ToolCallCardProps) {
  const last = messages[messages.length - 1];
  const parsed = parseMessage(last.content);
  if (!parsed) return null;

  const tc = parsed.sessionUpdate === 'tool_call' ? parsed : null;
  const tcu = parsed.sessionUpdate === 'tool_call_update' ? parsed : null;
  const data = tc || tcu;
  if (!data) return null;

  const kind = data.kind || 'other';
  const status = data.status || 'in_progress';
  const title = data.title || kindLabel(kind);
  const locations = data.locations;
  const rawInput = data.rawInput as Record<string, unknown> | undefined;
  const rawOutput = data.rawOutput as Record<string, unknown> | undefined;
  const contentItems = data.content as ToolCallContent[] | undefined;

  const containerClass = status === 'completed'
    ? 'rounded-lg border border-border bg-muted'
    : 'rounded-lg border border-border bg-muted';

  const summary = `${kindLabel(kind)} ${status === 'completed' ? '✓' : status === 'failed' ? '✗' : '...'}`;

  const renderBody = () => {
    if (kind === 'edit') {
      if (status === 'in_progress') {
        return (
          <div className="space-y-3">
            {locations && locations.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Files to modify</div>
                <div className="space-y-1">
                  {locations.map((loc, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm text-foreground">
                      <span className="text-muted-foreground">📄</span>
                      <span className="font-mono">{loc.path}</span>
                      {loc.line != null && (
                        <span className="text-xs text-muted-foreground">:{loc.line}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {rawInput && (
              <div>
                {(rawInput as EditRawInput).filePath && (
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    Editing: {(rawInput as EditRawInput).filePath}
                  </div>
                )}
                <DiffView
                  oldText={(rawInput as EditRawInput).oldString}
                  newText={(rawInput as EditRawInput).newString || ''}
                  inline
                />
              </div>
            )}
          </div>
        );
      }

      if (status === 'completed' && contentItems) {
        return (
          <div className="space-y-3">
            {contentItems.map((item, i) => renderContentItem(item, i))}
          </div>
        );
      }
    }

    if (kind === 'execute') {
      if (status === 'in_progress' && rawInput) {
        const exInput = rawInput as ExecuteRawInput;
        return (
          <div className="space-y-2 text-sm">
            {exInput.workDir && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Directory: </span>
                <span className="font-mono text-foreground">{exInput.workDir}</span>
              </div>
            )}
            {exInput.description && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Description: </span>
                <span className="text-foreground">{exInput.description}</span>
              </div>
            )}
            {exInput.command && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Command: </span>
                <pre className="mt-1 rounded bg-foreground p-2 font-mono text-sm text-background">
                  $ {exInput.command}
                </pre>
              </div>
            )}
            {exInput.timeout != null && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Timeout: </span>
                <span className="text-foreground">{exInput.timeout}s</span>
              </div>
            )}
          </div>
        );
      }

      if (status === 'completed' && rawOutput) {
        const output = (rawOutput as { output?: string }).output;
        if (output) {
          return (
            <div className="space-y-2">
              {rawInput && (rawInput as ExecuteRawInput).command && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">Command: </span>
                  <pre className="mt-1 rounded bg-foreground p-2 font-mono text-sm text-background">
                    $ {(rawInput as ExecuteRawInput).command}
                  </pre>
                </div>
              )}
              <TerminalOutput output={output} />
            </div>
          );
        }
      }
    }

    return (
      <div className="py-2 text-sm text-muted-foreground">
        {kindLabel(kind)} — {status}
      </div>
    );
  };

  return (
    <AcpCard
      title={`Tool Call: ${title}`}
      summary={summary}
      defaultCollapsed={true}
      color={status === 'completed' ? 'blue' : status === 'failed' ? 'yellow' : 'purple'}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <div className={containerClass}>
        <div className="p-3">
          {renderBody()}
        </div>
      </div>
    </AcpCard>
  );
}
