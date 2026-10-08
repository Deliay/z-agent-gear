import { resolveControllerApiBase } from '../lib/api-base';

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

function getUserIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.userId || null;
  } catch {
    return null;
  }
}

export async function fetchMcpProxyKeys(token: string): Promise<McpProxyKey[]> {
  const userId = getUserIdFromToken(token);
  if (!userId) throw new Error('Invalid token');

  const base = await resolveControllerApiBase();
  const response = await fetch(`${base}/api/mcp-proxy-keys`, {
    headers: {
      'x-user-id': userId,
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch MCP proxy keys');
  }
  return response.json();
}

export async function createMcpProxyKey(token: string, name: string): Promise<CreateMcpProxyKeyResult> {
  const userId = getUserIdFromToken(token);
  if (!userId) throw new Error('Invalid token');

  const base = await resolveControllerApiBase();
  const response = await fetch(`${base}/api/mcp-proxy-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userId,
    },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error('Failed to create MCP proxy key');
  }
  return response.json();
}

export async function revokeMcpProxyKey(token: string, id: string): Promise<void> {
  const userId = getUserIdFromToken(token);
  if (!userId) throw new Error('Invalid token');

  const base = await resolveControllerApiBase();
  const response = await fetch(`${base}/api/mcp-proxy-keys/${id}/revoke`, {
    method: 'POST',
    headers: {
      'x-user-id': userId,
    },
  });
  if (!response.ok) {
    throw new Error('Failed to revoke MCP proxy key');
  }
}
