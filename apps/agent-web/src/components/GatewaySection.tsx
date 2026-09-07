import { useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { GET_GATEWAYS } from '../graphql/queries';
import type { GetGatewaysQuery } from '../graphql/types';
import GatewayItem from './GatewayItem';
import GatewayDialog from './GatewayDialog';
import { ChevronDown, ChevronRight, ExternalLink, Plus } from 'lucide-react';

interface GatewaySectionProps {
  controllerId: string;
  inline?: boolean;
}

export default function GatewaySection({ controllerId, inline }: GatewaySectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showDialog, setShowDialog] = useState(false);

  const { data } = useQuery<GetGatewaysQuery>(GET_GATEWAYS, {
    variables: { controllerId },
    skip: !isExpanded && !inline,
  });

  const gateways = data?.gateways?.gateways ?? [];

  // inline 模式：由 TreeSection 包裹，直接渲染列表
  if (inline) {
    return (
      <>
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
        {showDialog && (
          <GatewayDialog
            controllerId={controllerId}
            onClose={() => setShowDialog(false)}
          />
        )}
      </>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors hover:bg-sidebar-accent">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 text-left"
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded((prev) => !prev);
          }}
        >
          <span className="text-xs text-muted-foreground">{isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}</span>
          <ExternalLink className="size-3 text-muted-foreground" />
          <span className="flex-1 truncate text-sidebar-foreground">统一网关</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowDialog(true);
          }}
          className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
        >
          <Plus className="size-3" />
        </button>
      </div>

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
