import type { SessionUpdate } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';

interface ToolCallCardProps {
  messages: Array<{ content: string | Record<string, unknown>; createdAt: string }>;
}

function parseToolCall(update: SessionUpdate) {
  if (update.sessionUpdate === 'tool_call') return update;
  return null;
}

function parseToolCallUpdate(update: SessionUpdate) {
  if (update.sessionUpdate === 'tool_call_update') return update;
  return null;
}

export default function ToolCallCard({ messages }: ToolCallCardProps) {
  let title = 'Tool Call';
  let status: string = 'in_progress';
  let rawInput: unknown = null;

  for (const msg of messages) {
    try {
      const parsed = typeof msg.content === 'object'
        ? msg.content as SessionUpdate
        : JSON.parse(msg.content) as SessionUpdate;
      const tc = parseToolCall(parsed);
      const tcu = parseToolCallUpdate(parsed);
      if (tc) {
        title = tc.title;
        if (tc.status) status = tc.status;
        if (tc.rawInput) rawInput = tc.rawInput;
      }
      if (tcu) {
        if (tcu.title) title = tcu.title;
        if (tcu.status) status = tcu.status;
        if (tcu.rawInput) rawInput = tcu.rawInput;
      }
    } catch {
      // ignore parse errors
    }
  }

  const statusColors: Record<string, string> = {
    pending: 'yellow',
    in_progress: 'purple',
    completed: 'blue',
    failed: 'gray',
  };

  return (
    <AcpCard
      title={`Tool Call: ${title}`}
      summary={status}
      defaultCollapsed={true}
      color={(statusColors[status] as 'yellow' | 'purple' | 'blue' | 'gray') || 'purple'}
    >
      {rawInput != null && (
        <div className="mb-2">
          <div className="text-xs font-medium text-gray-500 mb-1">Input</div>
          <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto">
            {typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2)}
          </pre>
        </div>
      )}
      <div className="text-xs text-gray-500">Status: {status}</div>
    </AcpCard>
  );
}
