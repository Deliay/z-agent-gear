import type { SessionUpdate } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';

interface ToolCallCardProps {
  messages: Array<{ content: string | Record<string, unknown>; createdAt: string }>;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

interface StatusEntry {
  status: string;
  timestamp: string;
  rawInput?: unknown;
  result?: unknown;
  log?: string;
}

export default function ToolCallCard({ messages, expanded, onExpandedChange }: ToolCallCardProps) {
  let title = 'Tool Call';
  let finalStatus: string = 'in_progress';
  const statusHistory: StatusEntry[] = [];

  for (const msg of messages) {
    try {
      const parsed = typeof msg.content === 'object'
        ? msg.content as SessionUpdate
        : JSON.parse(msg.content) as SessionUpdate;
      const tc = parsed.sessionUpdate === 'tool_call' ? parsed : null;
      const tcu = parsed.sessionUpdate === 'tool_call_update' ? parsed : null;

      if (tc) {
        if (tc.title) title = tc.title;
        const st = tc.status || 'pending';
        statusHistory.push({ status: st, timestamp: msg.createdAt, rawInput: tc.rawInput });
        if (tc.status) finalStatus = tc.status;
      }
      if (tcu) {
        if (tcu.title) title = tcu.title;
        const st = tcu.status || finalStatus;
        const entry: StatusEntry = { status: st, timestamp: msg.createdAt };
        if (tcu.rawInput) entry.rawInput = tcu.rawInput;
        if (tcu.result) entry.result = tcu.result;
        if (tcu.log) entry.log = tcu.log;
        statusHistory.push(entry);
        if (tcu.status) finalStatus = tcu.status;
      }
    } catch {
      // ignore parse errors
    }
  }

  const statusBadge: Record<string, { bg: string; text: string; label: string }> = {
    pending: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Pending' },
    in_progress: { bg: 'bg-purple-100', text: 'text-purple-800', label: 'In Progress' },
    completed: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Completed' },
    failed: { bg: 'bg-red-100', text: 'text-red-800', label: 'Failed' },
  };

  const finalBadge = statusBadge[finalStatus] || statusBadge.in_progress;

  return (
    <AcpCard
      title={`Tool Call: ${title}`}
      summary={finalBadge.label}
      defaultCollapsed={true}
      color={(finalStatus === 'completed' ? 'blue' : finalStatus === 'failed' ? 'yellow' : 'purple') as 'blue' | 'yellow' | 'purple'}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <div className="space-y-3">
        {/* Status timeline */}
        <div className="space-y-2">
          {statusHistory.map((entry, i) => {
            const badge = statusBadge[entry.status] || statusBadge.in_progress;
            return (
              <div key={i} className="flex items-start gap-2 text-sm">
                <div className="mt-0.5 flex flex-col items-center">
                  <div className={`h-2.5 w-2.5 rounded-full ${badge.bg} border-2 border-current ${badge.text}`} />
                  {i < statusHistory.length - 1 && <div className="mt-0.5 h-full w-px bg-gray-300" />}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${badge.bg} ${badge.text}`}>
                      {badge.label}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  {entry.rawInput != null && (
                    <div className="mt-1">
                      <div className="text-xs font-medium text-gray-500">Input</div>
                      <pre className="mt-0.5 max-h-32 overflow-y-auto rounded bg-gray-100 p-2 text-xs">
                        {typeof entry.rawInput === 'string' ? entry.rawInput : JSON.stringify(entry.rawInput, null, 2)}
                      </pre>
                    </div>
                  )}
                  {entry.result != null && (
                    <div className="mt-1">
                      <div className="text-xs font-medium text-gray-500">Result</div>
                      <pre className="mt-0.5 max-h-32 overflow-y-auto rounded bg-gray-100 p-2 text-xs">
                        {typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result, null, 2)}
                      </pre>
                    </div>
                  )}
                  {entry.log && (
                    <div className="mt-1">
                      <div className="text-xs font-medium text-gray-500">Log</div>
                      <pre className="mt-0.5 max-h-20 overflow-y-auto rounded bg-gray-50 p-2 text-xs text-gray-600">
                        {entry.log}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Final status summary */}
        <div className="flex items-center gap-2 border-t border-gray-200 pt-2 text-xs text-gray-500">
          <span>Final Status:</span>
          <span className={`inline-block rounded px-1.5 py-0.5 font-medium ${finalBadge.bg} ${finalBadge.text}`}>
            {finalBadge.label}
          </span>
        </div>
      </div>
    </AcpCard>
  );
}