import { useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { GET_PORT_FORWARDS } from '../graphql/queries';
import type { GetPortForwardsQuery } from '../graphql/types';
import PortForwardItem from './PortForwardItem';
import PortForwardDialog from './PortForwardDialog';

interface PortForwardSectionProps {
  controllerId: string;
}

export default function PortForwardSection({ controllerId }: PortForwardSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showDialog, setShowDialog] = useState(false);

  const { data } = useQuery<GetPortForwardsQuery>(GET_PORT_FORWARDS, {
    variables: { controllerId },
    skip: !isExpanded,
  });

  const portForwards = data?.portForwards?.portForwards ?? [];

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors hover:bg-gray-800"
        onClick={(e) => {
          e.stopPropagation();
          setIsExpanded((prev) => !prev);
        }}
      >
        <span className="text-xs text-gray-400">{isExpanded ? '▼' : '▶'}</span>
        <span className="text-xs text-gray-400">↗</span>
        <span className="flex-1 truncate text-left text-gray-300">端口转发</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowDialog(true);
          }}
          className="rounded bg-blue-600 px-1.5 py-0.5 text-xs text-white hover:bg-blue-700"
        >
          +
        </button>
      </button>

      {isExpanded && (
        <ul className="ml-4 space-y-1">
          {portForwards.length === 0 ? (
            <li className="px-3 py-1 text-xs text-gray-500">无端口转发</li>
          ) : (
            portForwards.map((pf) => (
              <PortForwardItem
                key={pf.id}
                portForward={pf}
                controllerId={controllerId}
              />
            ))
          )}
        </ul>
      )}

      {showDialog && (
        <PortForwardDialog
          controllerId={controllerId}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
}
