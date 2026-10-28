import AcpCard from './AcpCard';
import MarkdownContent from './MarkdownContent';
import ToolCallRawSection from './ToolCallRawSection';
import ToolKindIcon from './tool-call-icons';
import { toolCallColor, type MergedToolCall } from './tool-call-state';

interface SubAgentCardProps {
  toolCall: MergedToolCall;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export default function SubAgentCard({ toolCall, expanded, onExpandedChange }: SubAgentCardProps) {
  const rawInput = toolCall.rawInput as Record<string, unknown> | undefined;
  const rawOutput = toolCall.rawOutput as Record<string, unknown> | undefined;
  const status = toolCall.status || 'in_progress';
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
      color={toolCallColor(status)}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      icon={<ToolKindIcon kind={toolCall.kind} className="size-4" aria-hidden="true" />}
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
        <ToolCallRawSection label="输入" value={toolCall.rawInput} />
        <ToolCallRawSection label="输出" value={toolCall.rawOutput} />
      </div>
    </AcpCard>
  );
}
