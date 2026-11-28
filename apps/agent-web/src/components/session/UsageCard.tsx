import type { UsageUpdate } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';

interface UsageCardProps {
  data: UsageUpdate;
}

export default function UsageCard({ data }: UsageCardProps) {
  const summary = `本次消耗 ${data.used.toLocaleString()} Token`;

  return (
    <AcpCard
      title="用量统计"
      summary={summary}
      color="blue"
      defaultCollapsed={true}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">上下文窗口</span>
          <span className="text-sm font-medium text-foreground tabular-nums">
            {data.used.toLocaleString()} / {data.size.toLocaleString()} Token
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
            <span className="text-sm text-muted-foreground">费用</span>
            <span className="text-sm font-medium text-foreground tabular-nums">
              {data.cost.amount.toFixed(4)} {data.cost.currency}
            </span>
          </div>
        )}
      </div>
    </AcpCard>
  );
}
