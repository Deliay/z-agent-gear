const CONTROLLER_API_URL = import.meta.env.VITE_CONTROLLER_API_URL || 'http://localhost:4001';

export interface McpProxyKey {
  id: string;
  name: string;
  keyPrefix: string;
  status: 'active' | 'revoked';
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreateMcpProxyKeyResult {
  key: McpProxyKey;
  rawKey: string;
}

export async function fetchMcpProxyKeys(token: string): Promise<McpProxyKey[]> {
  const response = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch MCP proxy keys');
  }
  return response.json();
}

export async function createMcpProxyKey(token: string, name: string): Promise<CreateMcpProxyKeyResult> {
  const response = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error('Failed to create MCP proxy key');
  }
  return response.json();
}

export async function revokeMcpProxyKey(token: string, id: string): Promise<void> {
  const response = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys/${id}/revoke`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error('Failed to revoke MCP proxy key');
  }
}
