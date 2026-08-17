import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const body: Record<string, unknown> = { query };
  if (variables) {
    body.variables = variables;
  }
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id username }
    }
  }
`;

const GET_MCP_SERVERS = `
  query GetMcpServers {
    mcpServers {
      id
      name
      transport
      source
      enabled
      command
      url
      hostname
      status
      tools {
        name
        description
      }
      toolsSyncedAt
      lastHeartbeatAt
      createdAt
      updatedAt
    }
  }
`;

const GET_MCP_SERVER = `
  query GetMcpServer($id: ID!) {
    mcpServer(id: $id) {
      id
      name
      transport
      source
      enabled
      command
      url
      hostname
      status
      tools {
        name
        description
      }
      toolsSyncedAt
      lastHeartbeatAt
      createdAt
      updatedAt
    }
  }
`;

const SET_MCP_SERVER_ENABLED = `
  mutation SetMcpServerEnabled($id: ID!, $enabled: Boolean!) {
    setMcpServerEnabled(id: $id, enabled: $enabled) {
      id
      name
      enabled
      status
    }
  }
`;

let authToken: string;
let userId: string;

beforeAll(async () => {
  const username = `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const signupRes = await gqlRequest(SIGNUP, { username, password: 'password123' });
  const signupData = await signupRes.json() as any;
  authToken = signupData.data?.signup?.token;
  userId = signupData.data?.signup?.user?.id;
  if (!authToken) {
    console.error('Failed to get auth token:', signupData);
  }
});

describe('MCP Server API (agent-api)', () => {
  describe('mcpServers query', () => {
    it('should require authentication', async () => {
      const res = await gqlRequest(GET_MCP_SERVERS);
      const data = await res.json() as any;
      expect(data.errors?.[0]?.message).toContain('Not authenticated');
    });

    it('should return empty list for authenticated user', async () => {
      const res = await gqlRequest(GET_MCP_SERVERS, undefined, authToken);
      const data = await res.json() as any;
      expect(data.data?.mcpServers).toEqual([]);
    });
  });

  describe('mcpServer query', () => {
    it('should require authentication', async () => {
      const res = await gqlRequest(GET_MCP_SERVER, { id: 'nonexistent' });
      const data = await res.json() as any;
      expect(data.errors?.[0]?.message).toContain('Not authenticated');
    });

    it('should return null for non-existent server', async () => {
      const res = await gqlRequest(GET_MCP_SERVER, { id: '000000000000000000000000' }, authToken);
      const data = await res.json() as any;
      expect(data.data?.mcpServer).toBeNull();
    });
  });

  describe('setMcpServerEnabled mutation', () => {
    it('should require authentication', async () => {
      const res = await gqlRequest(SET_MCP_SERVER_ENABLED, { id: '000000000000000000000000', enabled: false });
      const data = await res.json() as any;
      expect(data.errors?.[0]?.message).toContain('Not authenticated');
    });

    it('should throw Server not found for non-existent server', async () => {
      const res = await gqlRequest(
        SET_MCP_SERVER_ENABLED,
        { id: '000000000000000000000000', enabled: false },
        authToken,
      );
      const data = await res.json() as any;
      expect(data.errors?.[0]?.message).toContain('Server not found');
    });
  });
});
