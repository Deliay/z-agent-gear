import { useQuery, useMutation } from '@apollo/client/react';
import { GET_ACP_CAPABILITIES } from '../../graphql/queries';
import { REFRESH_ACP_CAPABILITIES } from '../../graphql/mutations';
import type { GetAcpCapabilitiesQuery, RefreshAcpCapabilitiesMutation } from '../../graphql/types';
import { Button } from '@/components/ui/button';

interface HarnessToolsSectionProps {
  controllerId: string;
}

export default function HarnessToolsSection({ controllerId }: HarnessToolsSectionProps) {
  const { data, loading, refetch } = useQuery<GetAcpCapabilitiesQuery>(GET_ACP_CAPABILITIES, {
    variables: { controllerId },
    fetchPolicy: 'cache-and-network',
  });

  const [refresh, { loading: refreshing }] = useMutation<RefreshAcpCapabilitiesMutation>(REFRESH_ACP_CAPABILITIES);

  const capabilities = data?.acpCapabilities ?? [];
  const checkedAt = capabilities[0]?.checkedAt ?? null;

  const handleRefresh = async () => {
    await refresh({ variables: { controllerId } });
    refetch();
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">可用 Harness 工具</h2>
        <Button size="sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? '刷新中...' : '刷新'}
        </Button>
      </div>

      {checkedAt && (
        <p className="text-sm text-muted-foreground mb-4">
          上次检测：{new Date(checkedAt).toLocaleString()}
        </p>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : capabilities.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          当前控制器未检测到可用工具
        </div>
      ) : (
        <div className="space-y-2">
          {capabilities.map((cap) => (
            <div key={cap.type} className="flex items-center gap-3 rounded-lg border p-4">
              <div className={`h-2 w-2 rounded-full shrink-0 ${cap.available ? 'bg-green-500' : 'bg-gray-400'}`} />
              <div className="flex-1">
                <div className="font-medium">{cap.type}</div>
                {cap.version && (
                  <div className="text-sm text-muted-foreground">v{cap.version}</div>
                )}
              </div>
              <span className={`rounded px-1.5 py-0.5 text-xs ${
                cap.available ? 'bg-green-500/20 text-green-600' : 'bg-muted text-muted-foreground'
              }`}>
                {cap.available ? '可用' : '不可用'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
