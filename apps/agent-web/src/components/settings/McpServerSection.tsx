import { useQuery } from '@apollo/client/react';
import { GET_MCP_SERVERS } from '@/graphql/queries';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

interface McpServer {
  id: string;
  name: string;
  transport: string;
  command: string;
  status: 'active' | 'offline' | 'disabled';
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GetMcpServersData {
  mcpServers: McpServer[];
}

export default function McpServerSection() {
  const { data, loading, refetch } = useQuery<GetMcpServersData>(GET_MCP_SERVERS);

  const servers: McpServer[] = data?.mcpServers || [];

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-success';
      case 'offline':
        return 'bg-warning';
      case 'disabled':
        return 'bg-muted-foreground';
      default:
        return 'bg-muted-foreground';
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>MCP 服务</CardTitle>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中...</p>
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无已注册的 MCP 服务。使用 MCP 代理密钥注册本地 MCP 命令。
          </p>
        ) : (
          <div className="space-y-4">
            {servers.map((server) => (
              <div
                key={server.id}
                className="flex items-center justify-between rounded-lg border p-4"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{server.name}</span>
                    <Badge className={getStatusColor(server.status)}>
                      {server.status}
                    </Badge>
                  </div>
                  <code className="text-sm text-muted-foreground">{server.command}</code>
                  {server.lastHeartbeatAt && (
                    <p className="text-xs text-muted-foreground">
                      最后心跳: {new Date(server.lastHeartbeatAt).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
