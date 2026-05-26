import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import AcpCard from './AcpCard';

interface PlanCardProps {
  messages: Array<{ content: string | Record<string, unknown>; createdAt: string }>;
}

function parsePlan(update: SessionUpdate) {
  if (update.sessionUpdate === 'plan') return update;
  return null;
}

const statusIcons = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
};

const statusColors = {
  pending: 'text-gray-400',
  in_progress: 'text-blue-500',
  completed: 'text-green-600',
};

const statusLabels = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
};

export default function PlanCard({ messages }: PlanCardProps) {
  let entries: Array<{ content: string; status: string; priority: string }> = [];

  for (const msg of messages) {
    try {
      const parsed = typeof msg.content === 'object'
        ? msg.content as SessionUpdate
        : JSON.parse(msg.content) as SessionUpdate;
      const plan = parsePlan(parsed);
      if (plan) {
        entries = plan.entries.map(e => ({
          content: e.content,
          status: e.status || 'pending',
          priority: e.priority || 'medium',
        }));
      }
    } catch {
      // ignore parse errors
    }
  }

  if (entries.length === 0) return null;

  const completed = entries.filter(e => e.status === 'completed').length;
  const total = entries.length;
  const summary = `${completed}/${total} completed`;

  return (
    <AcpCard
      title="Plan"
      summary={summary}
      defaultCollapsed={false}
      color="yellow"
    >
      <div className="space-y-2">
        {entries.map((entry, i) => {
          const Icon = statusIcons[entry.status as keyof typeof statusIcons] || Circle;
          const colorClass = statusColors[entry.status as keyof typeof statusColors] || 'text-gray-400';
          const label = statusLabels[entry.status as keyof typeof statusLabels] || 'Pending';
          return (
            <div key={i} className="flex items-start gap-2">
              <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${entry.status === 'in_progress' ? 'animate-spin' : ''} ${colorClass}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-yellow-900 whitespace-pre-wrap break-words">
                  {entry.content}
                </div>
                <div className={`text-xs mt-0.5 ${colorClass}`}>{label}</div>
              </div>
            </div>
          );
        })}
      </div>
    </AcpCard>
  );
}
