import type { ToolCallContent } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';
import DiffView from './DiffView';
import TerminalOutput from './TerminalOutput';
import ContentBlockRenderer from './ContentBlockRenderer';
import ToolCallRawSection from './ToolCallRawSection';
import ToolKindIcon from './tool-call-icons';
import {
  kindLabel,
  toolCallColor,
  toolCallHeaderTitle,
  type MergedToolCall,
} from './tool-call-state';

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

export default function ToolCallCard({ toolCall, expanded, onExpandedChange }: ToolCallCardProps) {
  const kind = toolCall.kind || 'other';
  const status = toolCall.status || 'in_progress';
  const isActive = status === 'in_progress' || status === 'pending';
  const title = toolCallHeaderTitle(toolCall);
  const locations = toolCall.locations;
  const rawInput = asRecord(toolCall.rawInput);
  const rawOutput = asRecord(toolCall.rawOutput);
  const contentItems = toolCall.content as ToolCallContent[] | undefined;

  const summary = `${kindLabel(kind)} ${status === 'completed' ? '✓' : status === 'failed' ? '✗' : '...'}`;

  const renderCommand = (input: ExecuteRawInput | undefined) => (
    input?.command ? (
      <div className="min-w-0">
        <span className="text-xs font-medium text-muted-foreground">Command: </span>
        <pre className="mt-1 rounded bg-muted p-2 font-mono text-sm whitespace-pre-wrap break-all text-foreground">
          $ {input.command}
        </pre>
      </div>
    ) : null
  );

  const renderBody = () => {
    if (kind === 'edit') {
      const editInput = rawInput as EditRawInput | undefined;
      const filePath = editInput?.filePath || locations?.[0]?.path;
      const hasInputDiff = Boolean(
        editInput && (typeof editInput.oldString === 'string' || typeof editInput.newString === 'string'),
      );

      return (
        <div className="space-y-3">
          {isActive && locations && locations.length > 0 && (
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
          {filePath && (
            <div className="text-xs font-medium text-muted-foreground">
              Editing: {filePath}
            </div>
          )}
          {/* 终态无 content 时保留创建时的参数/diff 展示（R-4） */}
          {hasInputDiff && (!contentItems || contentItems.length === 0) && (
            <DiffView
              oldText={editInput?.oldString}
              newText={editInput?.newString || ''}
              filePath={filePath}
              inline
            />
          )}
          {contentItems && contentItems.length > 0 && (
            <ContentBlockRenderer content={contentItems} />
          )}
          {!filePath && !hasInputDiff && (!contentItems || contentItems.length === 0) && (
            <div className="py-2 text-sm text-muted-foreground">
              {kindLabel(kind)} — {status}
            </div>
          )}
        </div>
      );
    }

    if (kind === 'execute') {
      const execInput = rawInput as ExecuteRawInput | undefined;
      const output = typeof rawOutput?.output === 'string' ? rawOutput.output : '';
      const hasOutput = output.length > 0;

      // 终态（completed / failed）携带输出即渲染终端；失败恰是最需要看输出的场景（R-4）
      if (!isActive && hasOutput) {
        return (
          <div className="space-y-2">
            {renderCommand(execInput)}
            <TerminalOutput output={output} />
          </div>
        );
      }

      if (contentItems && contentItems.length > 0) {
        return (
          <div className="space-y-2">
            {renderCommand(execInput)}
            <ContentBlockRenderer content={contentItems} />
          </div>
        );
      }

      if (!isActive) {
        return (
          <div className="space-y-2 text-sm">
            {renderCommand(execInput)}
            {execInput?.workDir && (
              <div className="min-w-0">
                <span className="text-xs font-medium text-muted-foreground">Directory: </span>
                <span className="font-mono break-all text-foreground">{execInput.workDir}</span>
              </div>
            )}
            <div className="py-2 text-muted-foreground">
              {kindLabel(kind)} — {status}
            </div>
          </div>
        );
      }

      const activeInput = execInput;
      if (activeInput) {
        return (
          <div className="space-y-2 text-sm">
            {activeInput.workDir && (
              <div className="min-w-0">
                <span className="text-xs font-medium text-muted-foreground">Directory: </span>
                <span className="font-mono break-all text-foreground">{activeInput.workDir}</span>
              </div>
            )}
            {activeInput.description && (
              <div className="min-w-0">
                <span className="text-xs font-medium text-muted-foreground">Description: </span>
                <span className="text-foreground">{activeInput.description}</span>
              </div>
            )}
            {renderCommand(activeInput)}
            {activeInput.timeout != null && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Timeout: </span>
                <span className="text-foreground">{activeInput.timeout}s</span>
              </div>
            )}
            {hasOutput && <TerminalOutput output={output} />}
          </div>
        );
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
      title={title}
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
          <ToolCallRawSection
            label="输入"
            value={toolCall.rawInput}
            missingHint="输入不可得：创建事件缺失或已被历史窗口截断"
          />
          <ToolCallRawSection label="输出" value={toolCall.rawOutput} />
        </div>
      </div>
    </AcpCard>
  );
}
