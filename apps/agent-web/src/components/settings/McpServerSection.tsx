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
        return 'bg-green-500';
      case 'offline':
        return 'bg-yellow-500';
      case 'disabled':
        return 'bg-gray-500';
      default:
        return 'bg-gray-500';
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>MCP Servers</CardTitle>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No MCP servers registered yet. Use the MCP Proxy Key to register local MCP commands.
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
                      Last heartbeat: {new Date(server.lastHeartbeatAt).toLocaleString()}
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
