import { useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { GET_GATEWAYS } from '../graphql/queries';
import type { GetGatewaysQuery } from '../graphql/types';
import GatewayItem from './GatewayItem';
import GatewayDialog from './GatewayDialog';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

interface GatewaySectionProps {
  controllerId: string;
}

export default function GatewaySection({ controllerId }: GatewaySectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showDialog, setShowDialog] = useState(false);

  const { data } = useQuery<GetGatewaysQuery>(GET_GATEWAYS, {
    variables: { controllerId },
    skip: !isExpanded,
  });

  const gateways = data?.gateways?.gateways ?? [];

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors hover:bg-sidebar-accent"
        onClick={(e) => {
          e.stopPropagation();
          setIsExpanded((prev) => !prev);
        }}
      >
        <span className="text-xs text-muted-foreground">{isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}</span>
        <ExternalLink className="size-3 text-muted-foreground" />
        <span className="flex-1 truncate text-left text-sidebar-foreground">统一网关</span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setShowDialog(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              setShowDialog(true);
            }
          }}
          className="inline-flex h-6 items-center justify-center rounded px-2 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
        >
          +
        </span>
      </button>

      {isExpanded && (
        <ul className="ml-4 space-y-1">
          {gateways.length === 0 ? (
            <li className="px-3 py-1 text-xs text-muted-foreground">无网关暴露</li>
          ) : (
            gateways.map((gw) => (
              <GatewayItem
                key={gw.id}
                gateway={gw}
                controllerId={controllerId}
              />
            ))
          )}
        </ul>
      )}

      {showDialog && (
        <GatewayDialog
          controllerId={controllerId}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
}
