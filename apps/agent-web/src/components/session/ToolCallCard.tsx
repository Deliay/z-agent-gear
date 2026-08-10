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
    case 'delete': return 'Delete';
    case 'move': return 'Move';
    case 'search': return 'Search';
    case 'think': return 'Think';
    default: return kind || 'Tool Call';
  }
}

function pick(raw: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!raw) return undefined;
  for (const key of keys) {
    const v = raw[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

function renderContentItem(item: ToolCallContent, i: number) {
  if (item.type === 'content') {
    const cb = item.content;
    if (cb.type === 'text') {
      return (
        <div key={i} className="prose prose-sm max-w-none text-foreground">
          <div className="whitespace-pre-wrap break-all">{cb.text}</div>
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
  const isActive = status === 'in_progress' || status === 'pending';
  const title = data.title || kindLabel(kind);
  const locations = data.locations;
  const rawInput = data.rawInput as Record<string, unknown> | undefined;
  const rawOutput = data.rawOutput as Record<string, unknown> | undefined;
  const contentItems = data.content as ToolCallContent[] | undefined;

  const summary = `${kindLabel(kind)} ${status === 'completed' ? '✓' : status === 'failed' ? '✗' : '...'}`;

  const renderBody = () => {
    if (kind === 'edit') {
      if (isActive) {
        return (
          <div className="space-y-3">
            {locations && locations.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Files to modify</div>
                <div className="space-y-1">
                  {locations.map((loc, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm text-foreground">
                      <span className="text-muted-foreground">📄</span>
                      <span className="font-mono break-all">{loc.path}</span>
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
      if (isActive && rawInput) {
        const exInput = rawInput as ExecuteRawInput;
        return (
          <div className="space-y-2 text-sm">
            {exInput.workDir && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Directory: </span>
                <span className="font-mono break-all text-foreground">{exInput.workDir}</span>
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
                <pre className="mt-1 rounded bg-muted p-2 font-mono text-sm whitespace-pre-wrap break-all text-foreground">
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
                  <pre className="mt-1 rounded bg-muted p-2 font-mono text-sm whitespace-pre-wrap break-all text-foreground">
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

    if (kind === 'delete') {
      const filePath = pick(rawInput as Record<string, unknown>, ['filePath', 'file_path']);
      return (
        <div className="space-y-2 text-sm">
          {filePath && (
            <div className="flex items-center gap-2 text-destructive">
              <span className="text-base">🗑️</span>
              <span className="font-mono break-all">{filePath}</span>
            </div>
          )}
          {!filePath && (
            <div className="text-destructive">删除操作 — {status}</div>
          )}
        </div>
      );
    }

    if (kind === 'move') {
      const source = pick(rawInput as Record<string, unknown>, ['sourcePath', 'source_path', 'from']);
      const dest = pick(rawInput as Record<string, unknown>, ['destinationPath', 'destination_path', 'to']);
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {source && <span className="font-mono break-all text-foreground">{source}</span>}
          <span className="text-muted-foreground">→</span>
          {dest && <span className="font-mono break-all text-foreground">{dest}</span>}
        </div>
      );
    }

    if (kind === 'search') {
      const query = pick(rawInput as Record<string, unknown>, ['query', 'pattern']);
      return (
        <div className="space-y-2 text-sm">
          {query && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Query: </span>
              <span className="rounded bg-muted px-2 py-0.5 font-mono break-all text-foreground">"{query}"</span>
            </div>
          )}
        </div>
      );
    }

    if (kind === 'think') {
      const thoughts = pick(rawOutput as Record<string, unknown>, ['thoughts', 'text', 'reasoning']);
      return (
        <div className="rounded border border-border bg-muted/50 p-2 text-sm">
          <div className="mb-1 text-xs font-medium text-muted-foreground">💭 Thinking</div>
          <div className="whitespace-pre-wrap break-all text-foreground/80">{thoughts ?? '思考中...'}</div>
        </div>
      );
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
      color={status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'active'}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <div className="rounded-lg border border-border bg-muted">
        <div className="p-3">
          {renderBody()}
        </div>
      </div>
    </AcpCard>
  );
}
