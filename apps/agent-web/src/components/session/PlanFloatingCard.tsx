import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

interface PlanFloatingCardProps {
  messages: Array<{ content: string | Record<string, unknown>; createdAt: string }>;
}

interface PlanEntry {
  content: string;
  status: string;
  priority: string;
}

const statusIcons = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
};

const statusColors = {
  pending: 'text-muted-foreground',
  in_progress: 'text-primary',
  completed: 'text-green-600',
};

const statusLabels = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
};

function parsePlanEntries(messages: Array<{ content: string | Record<string, unknown> }>): PlanEntry[] {
  let entries: PlanEntry[] = [];
  for (const msg of messages) {
    try {
      const parsed = typeof msg.content === 'object'
        ? msg.content as SessionUpdate
        : JSON.parse(msg.content) as SessionUpdate;
      if (parsed.sessionUpdate === 'plan') {
        entries = parsed.entries.map(e => ({
          content: e.content,
          status: e.status || 'pending',
          priority: e.priority || 'medium',
        }));
      }
    } catch {
      // ignore parse errors
    }
  }
  return entries;
}

export default function PlanFloatingCard({ messages }: PlanFloatingCardProps) {
  const [expanded, setExpanded] = useState(false);
  const entries = parsePlanEntries(messages);

  if (entries.length === 0) return null;

  const completed = entries.filter(e => e.status === 'completed').length;
  const total = entries.length;
  const lastEntry = entries[entries.length - 1];

  return (
    <div className="sticky top-0 z-10 mb-2 rounded-lg border border-border bg-muted/90 shadow-md backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-yellow-800 hover:opacity-80 transition-opacity"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-yellow-400" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-yellow-400" />
        )}
        <span className="text-sm font-medium">Plan</span>
        {!expanded && (
          <span className="ml-auto truncate text-xs text-yellow-700 max-w-[50%]">
            {lastEntry.content}
          </span>
        )}
        <span className="ml-2 text-xs text-yellow-600">
          {completed}/{total} completed
        </span>
      </button>
      {expanded && (
        <div className="space-y-1.5 border-t border-yellow-200 px-3 py-2">
          {entries.map((entry, i) => {
            const Icon = statusIcons[entry.status as keyof typeof statusIcons] || Circle;
            const colorClass = statusColors[entry.status as keyof typeof statusColors] || 'text-muted-foreground';
            const label = statusLabels[entry.status as keyof typeof statusLabels] || 'Pending';
            return (
              <div key={i} className="flex items-start gap-2">
                <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${entry.status === 'in_progress' ? 'animate-spin' : ''} ${colorClass}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-foreground whitespace-pre-wrap break-words">
                    {entry.content}
                  </div>
                  <div className={`text-xs mt-0.5 ${colorClass}`}>{label}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
