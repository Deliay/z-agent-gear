import { useQuery, useMutation } from '@apollo/client/react';
import { GET_MCP_SERVERS } from '@/graphql/queries';
import { SET_MCP_SERVER_ENABLED } from '@/graphql/mutations';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

interface McpServerTool {
  name: string;
  description?: string | null;
}

interface McpServer {
  id: string;
  name: string;
  transport: string;
  source: 'proxy' | 'manual' | 'platform';
  enabled: boolean;
  command: string | null;
  url: string | null;
  hostname: string | null;
  status: 'active' | 'offline' | 'disabled';
  tools: McpServerTool[];
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GetMcpServersData {
  mcpServers: McpServer[];
}

const SOURCE_LABELS: Record<string, string> = {
  proxy: '代理注册',
  manual: '远程绑定',
  platform: '平台内置',
};

export default function McpRegistrySection() {
  const { data, loading, refetch } = useQuery<GetMcpServersData>(GET_MCP_SERVERS);
  const [setEnabled] = useMutation(SET_MCP_SERVER_ENABLED);

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

  const handleToggleEnabled = async (server: McpServer) => {
    try {
      await setEnabled({
        variables: { id: server.id, enabled: !server.enabled },
        refetchQueries: [{ query: GET_MCP_SERVERS }],
      });
    } catch (error) {
      console.error('Failed to toggle MCP server:', error);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>MCP 目录</CardTitle>
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
                    <Badge variant="secondary">{SOURCE_LABELS[server.source] ?? server.source}</Badge>
                    <Badge className={getStatusColor(server.status)}>
                      {server.status}
                    </Badge>
                    {!server.enabled && (
                      <Badge variant="outline">已停用</Badge>
                    )}
                  </div>
                  {server.command && (
                    <code className="text-sm text-muted-foreground">{server.command}</code>
                  )}
                  {server.hostname && (
                    <p className="text-xs text-muted-foreground">来源机器: {server.hostname}</p>
                  )}
                  {server.tools.length > 0 && (
                    <p className="text-xs text-muted-foreground">工具数: {server.tools.length}</p>
                  )}
                  {server.lastHeartbeatAt && (
                    <p className="text-xs text-muted-foreground">
                      最后心跳: {new Date(server.lastHeartbeatAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={() => handleToggleEnabled(server)}
                    className="h-4 w-4"
                  />
                  <span className="text-sm text-foreground">启用</span>
                </label>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
