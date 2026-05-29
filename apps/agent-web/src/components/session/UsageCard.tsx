import type { UsageUpdate } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';

interface UsageCardProps {
  data: UsageUpdate;
}

export default function UsageCard({ data }: UsageCardProps) {
  const summary = `本次消耗 ${data.used} tokens`;

  return (
    <AcpCard
      title="Usage"
      summary={summary}
      color="blue"
      defaultCollapsed={true}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Context Window</span>
          <span className="text-sm font-medium text-foreground">
            {data.used.toLocaleString()} / {data.size.toLocaleString()} tokens
          </span>
        </div>
        <div className="w-full bg-muted rounded-full h-2">
          <div
            className="bg-primary h-2 rounded-full transition-all duration-300"
            style={{ width: `${Math.min((data.used / data.size) * 100, 100)}%` }}
          />
        </div>
        {data.cost && (
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <span className="text-sm text-muted-foreground">Cost</span>
            <span className="text-sm font-medium text-foreground">
              {data.cost.amount.toFixed(4)} {data.cost.currency}
            </span>
          </div>
        )}
      </div>
    </AcpCard>
  );
}
