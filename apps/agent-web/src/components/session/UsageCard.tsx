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
          <span className="text-sm text-gray-600">Context Window</span>
          <span className="text-sm font-medium text-gray-800">
            {data.used.toLocaleString()} / {data.size.toLocaleString()} tokens
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${Math.min((data.used / data.size) * 100, 100)}%` }}
          />
        </div>
        {data.cost && (
          <div className="flex items-center justify-between pt-2 border-t border-gray-200">
            <span className="text-sm text-gray-600">Cost</span>
            <span className="text-sm font-medium text-gray-800">
              {data.cost.amount.toFixed(4)} {data.cost.currency}
            </span>
          </div>
        )}
      </div>
    </AcpCard>
  );
}
