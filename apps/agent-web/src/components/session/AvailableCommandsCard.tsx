import type { AvailableCommandsUpdate } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';

interface AvailableCommandsCardProps {
  data: AvailableCommandsUpdate;
}

export default function AvailableCommandsCard({ data }: AvailableCommandsCardProps) {
  const count = data.availableCommands.length;
  const summary = `${count} 个工具已加载`;

  return (
    <AcpCard
      title="Tools"
      summary={summary}
      color="purple"
      defaultCollapsed={true}
    >
      <div className="space-y-2">
        {data.availableCommands.map((cmd) => (
          <div
            key={cmd.name}
            className="rounded-md bg-white border border-purple-100 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <code className="text-sm font-mono font-medium text-purple-700">
                {cmd.name}
              </code>
            </div>
            <p className="mt-1 text-xs text-gray-600">{cmd.description}</p>
          </div>
        ))}
      </div>
    </AcpCard>
  );
}
