import type { ToolCallContent } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';
import DiffView from './DiffView';
import TerminalOutput from './TerminalOutput';
import ContentBlockRenderer from './ContentBlockRenderer';
import ToolCallRawSection from './ToolCallRawSection';
import ToolKindIcon from './tool-call-icons';
import { kindLabel, toolCallColor, toolCallTitle, type MergedToolCall } from './tool-call-state';

interface ToolCallCardProps {
  toolCall: MergedToolCall;
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

function pick(raw: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!raw) return undefined;
  for (const key of keys) {
    const v = raw[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export default function ToolCallCard({ toolCall, expanded, onExpandedChange }: ToolCallCardProps) {
  const kind = toolCall.kind || 'other';
  const status = toolCall.status || 'in_progress';
  const isActive = status === 'in_progress' || status === 'pending';
  const title = toolCallTitle(toolCall);
  const locations = toolCall.locations;
  const rawInput = toolCall.rawInput as Record<string, unknown> | undefined;
  const rawOutput = toolCall.rawOutput as Record<string, unknown> | undefined;
  const contentItems = toolCall.content as ToolCallContent[] | undefined;

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

      if (contentItems && contentItems.length > 0) {
        return <ContentBlockRenderer content={contentItems} />;
      }
    }

    if (kind === 'execute') {
      if (isActive && rawInput) {
        const exInput = rawInput as ExecuteRawInput;
        return (
          <div className="space-y-2 text-sm">
            {exInput.workDir && (
              <div className="min-w-0">
                <span className="text-xs font-medium text-muted-foreground">Directory: </span>
                <span className="font-mono break-all text-foreground">{exInput.workDir}</span>
              </div>
            )}
            {exInput.description && (
              <div className="min-w-0">
                <span className="text-xs font-medium text-muted-foreground">Description: </span>
                <span className="text-foreground">{exInput.description}</span>
              </div>
            )}
            {exInput.command && (
              <div className="min-w-0">
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
                <div className="min-w-0">
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
      const filePath = pick(rawInput, ['filePath', 'file_path']);
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
      const source = pick(rawInput, ['sourcePath', 'source_path', 'from']);
      const dest = pick(rawInput, ['destinationPath', 'destination_path', 'to']);
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {source && <span className="min-w-0 font-mono break-all text-foreground">{source}</span>}
          <span className="text-muted-foreground">→</span>
          {dest && <span className="min-w-0 font-mono break-all text-foreground">{dest}</span>}
        </div>
      );
    }

    if (kind === 'search') {
      const query = pick(rawInput, ['query', 'pattern']);
      return (
        <div className="space-y-2 text-sm">
          {query && (
            <div className="min-w-0">
              <span className="text-xs font-medium text-muted-foreground">Query: </span>
              <span className="rounded bg-muted px-2 py-0.5 font-mono break-all text-foreground">"{query}"</span>
            </div>
          )}
        </div>
      );
    }

    if (kind === 'think') {
      const thoughts = pick(rawOutput, ['thoughts', 'text', 'reasoning']);
      return (
        <div className="rounded border border-border bg-muted/50 p-2 text-sm">
          <div className="mb-1 text-xs font-medium text-muted-foreground">💭 Thinking</div>
          <div className="whitespace-pre-wrap break-all text-foreground/80">{thoughts ?? '思考中...'}</div>
        </div>
      );
    }

    if (contentItems && contentItems.length > 0) {
      return <ContentBlockRenderer content={contentItems} />;
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
      color={toolCallColor(status)}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      icon={<ToolKindIcon kind={kind} className="size-4" aria-hidden="true" />}
    >
      <div className="rounded-lg border border-border bg-muted">
        <div className="p-3">
          {status === 'pending' && (
            <div className="mb-2 text-xs text-muted-foreground">等待确认</div>
          )}
          {renderBody()}
          <ToolCallRawSection label="输入" value={toolCall.rawInput} />
          <ToolCallRawSection label="输出" value={toolCall.rawOutput} />
        </div>
      </div>
    </AcpCard>
  );
}
